/* Remorse Chess engine.
 * Standard chess + the killer's reaction. After a capture by a non-psycho piece the
 * capturing player rolls a die (a separate 'roll' action) to decide how it reacts:
 *   1    devastated  – immobilised, attacks nothing; absolve it within 3 of its owner's
 *                      turns or it takes its own life (is removed from the board)
 *   2-3  remorseful  – cannot capture (nor give check) until absolved
 *   4-5  unaffected
 *   6    psychopath  – permanent and incurable, never rolls again. Each later capture
 *                      earns a mandatory bonus move with the same piece (no chaining).
 *                      After 3 kills as a psycho (the 6-roll kill is #1) it gains bloodlust: it only moves to
 *                      capture, and will capture friendly pieces (never a king).
 * Absolution (cures remorseful and devastated pieces):
 *  - a healthy bishop (either colour) that moves to a square orthogonally next to
 *    afflicted pieces absolves them instantly (a piece moving next to a bishop doesn't
 *    count). A bishop that captured absolves only if its roll leaves it healthy (4-6);
 *  - instead of moving, a player may spend the turn having one of their own healthy
 *    bishops absolve every afflicted piece orthogonally next to it;
 *  - an afflicted bishop absolves no one, but its owner may spend a turn to absolve it.
 * Kings are never captured.
 * Board: array of 64, index = rank*8 + file, rank 0 = White's back rank (a1 = 0).
 * Piece: {t:'PNBRQK', c:'w'|'b', r:remorseful, dev:turns left (0 = not devastated),
 *         psy:psychopath, k:captures made}
 * State phase: 'move' | 'roll' (pending = square of the piece awaiting its roll)
 *            | 'bonus' (pending = square of the psycho owing its bonus move).
 * Actions: move {from,to,promo?,cap?,ep?,castle?,dbl?}, roll {roll:1-6},
 *          absolve {from: bishopSq, to: bishopSq, absolve:'adj'|'self'}.
 */
(function (root) {
  const KN = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
  const KG = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const DG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const OR = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const DEV_TURNS = 3, BLOODLUST_KILLS = 3;

  const inb = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;
  const opp = (c) => (c === 'w' ? 'b' : 'w');
  const sqName = (i) => 'abcdefgh'[i & 7] + ((i >> 3) + 1);
  const mk = (t, c) => ({ t, c, r: false, dev: 0, psy: false, k: 0 });
  const afflicted = (p) => !!(p && (p.r || p.dev > 0));
  const isBloodlust = (p) => !!(p && p.psy && p.k >= BLOODLUST_KILLS);
  const reaction = (n) => (n === 1 ? 'devastated' : n <= 3 ? 'remorseful' : n <= 5 ? 'unaffected' : 'psycho');

  // Squares orthogonally next to `sq` holding a remorseful or devastated piece.
  function afflictedNeighbours(b, sq) {
    const f = sq & 7, r = sq >> 3, out = [];
    for (const [df, dr] of OR) {
      if (!inb(f + df, r + dr)) continue;
      const i = (r + dr) * 8 + f + df;
      if (afflicted(b[i])) out.push(i);
    }
    return out;
  }

  function newGame(opts) {
    const b = new Array(64).fill(null);
    const back = 'RNBQKBNR';
    for (let f = 0; f < 8; f++) {
      b[f] = mk(back[f], 'w'); b[8 + f] = mk('P', 'w');
      b[48 + f] = mk('P', 'b'); b[56 + f] = mk(back[f], 'b');
    }
    return {
      board: b, turn: 'w',
      castle: { wK: true, wQ: true, bK: true, bQ: true },
      ep: -1, half: 0, full: 1, phase: 'move', pending: -1,
      remorse: !opts || opts.remorse !== false,
    };
  }

  function clone(s) {
    return {
      board: s.board.map((p) => (p ? { ...p } : null)),
      turn: s.turn, castle: { ...s.castle }, ep: s.ep, half: s.half, full: s.full,
      phase: s.phase, pending: s.pending, remorse: s.remorse,
    };
  }

  // Is square `sq` attacked by color `by`? Remorseful and devastated pieces attack nothing.
  function attacked(s, sq, by) {
    const b = s.board, f = sq & 7, r = sq >> 3;
    const live = (p, ts) => p && p.c === by && !afflicted(p) && ts.includes(p.t);
    const pr = r + (by === 'w' ? -1 : 1);
    for (const df of [-1, 1]) if (inb(f + df, pr) && live(b[pr * 8 + f + df], 'P')) return true;
    for (const [df, dr] of KN) if (inb(f + df, r + dr) && live(b[(r + dr) * 8 + f + df], 'N')) return true;
    for (const [df, dr] of KG) if (inb(f + df, r + dr) && live(b[(r + dr) * 8 + f + df], 'K')) return true;
    for (const [dirs, ts] of [[DG, 'BQ'], [OR, 'RQ']]) {
      for (const [df, dr] of dirs) {
        let x = f + df, y = r + dr;
        while (inb(x, y)) {
          const p = b[y * 8 + x];
          if (p) { if (live(p, ts)) return true; break; }
          x += df; y += dr;
        }
      }
    }
    return false;
  }

  function kingSq(s, c) {
    for (let i = 0; i < 64; i++) { const p = s.board[i]; if (p && p.t === 'K' && p.c === c) return i; }
    return -1;
  }
  const inCheck = (s, c) => { const k = kingSq(s, c); return k >= 0 && attacked(s, k, opp(c)); };

  // Pseudo-legal actions for the side to move.
  function pseudo(s) {
    if (s.phase === 'roll') return [1, 2, 3, 4, 5, 6].map((roll) => ({ roll }));
    const b = s.board, c = s.turn, out = [];
    const add = (from, to, extra) => out.push(Object.assign({ from, to }, extra));
    for (let i = 0; i < 64; i++) {
      if (s.phase === 'bonus' && i !== s.pending) continue;
      const p = b[i];
      if (!p || p.c !== c || p.dev) continue;          // devastated pieces are immobilised
      const f = i & 7, r = i >> 3;
      const canCap = !p.r, bl = isBloodlust(p), quiet = !bl;
      const prey = (q) => q && q.t !== 'K' && (q.c !== c || bl);
      if (p.t === 'P') {
        const d = c === 'w' ? 1 : -1, start = c === 'w' ? 1 : 6, last = c === 'w' ? 7 : 0;
        const push = (to, extra) => {
          if ((to >> 3) === last) for (const pr of 'QRBN') add(i, to, Object.assign({ promo: pr }, extra));
          else add(i, to, extra);
        };
        if (quiet && inb(f, r + d) && !b[(r + d) * 8 + f]) {
          push((r + d) * 8 + f);
          if (r === start && !b[(r + 2 * d) * 8 + f]) add(i, (r + 2 * d) * 8 + f, { dbl: true });
        }
        if (canCap) for (const df of [-1, 1]) {
          if (!inb(f + df, r + d)) continue;
          const to = (r + d) * 8 + f + df, q = b[to];
          if (prey(q)) push(to, { cap: true });
          else if (!q && to === s.ep) add(i, to, { cap: true, ep: true });
        }
      } else if (p.t === 'N' || p.t === 'K') {
        for (const [df, dr] of p.t === 'N' ? KN : KG) {
          if (!inb(f + df, r + dr)) continue;
          const to = (r + dr) * 8 + f + df, q = b[to];
          if (!q) { if (quiet) add(i, to); }
          else if (canCap && prey(q)) add(i, to, { cap: true });
        }
        if (p.t === 'K' && quiet && s.phase === 'move') {
          const row = c === 'w' ? 0 : 7;
          if (i === row * 8 + 4 && !inCheck(s, c)) {
            const en = opp(c);
            if (s.castle[c + 'K'] && b[row * 8 + 7] && b[row * 8 + 7].t === 'R' && b[row * 8 + 7].c === c &&
              !b[row * 8 + 5] && !b[row * 8 + 6] && !attacked(s, row * 8 + 5, en) && !attacked(s, row * 8 + 6, en))
              add(i, row * 8 + 6, { castle: 'K' });
            if (s.castle[c + 'Q'] && b[row * 8] && b[row * 8].t === 'R' && b[row * 8].c === c &&
              !b[row * 8 + 1] && !b[row * 8 + 2] && !b[row * 8 + 3] && !attacked(s, row * 8 + 3, en) && !attacked(s, row * 8 + 2, en))
              add(i, row * 8 + 2, { castle: 'Q' });
          }
        }
      } else {
        const dirs = p.t === 'B' ? DG : p.t === 'R' ? OR : KG;
        for (const [df, dr] of dirs) {
          let x = f + df, y = r + dr;
          while (inb(x, y)) {
            const to = y * 8 + x, q = b[to];
            if (!q) { if (quiet) add(i, to); }
            else { if (canCap && prey(q)) add(i, to, { cap: true }); break; }
            x += df; y += dr;
          }
        }
      }
    }
    // Absolution in place (costs the turn, nothing moves).
    if (s.remorse && s.phase === 'move') for (let i = 0; i < 64; i++) {
      const p = b[i];
      if (!p || p.c !== c || p.t !== 'B') continue;
      if (afflicted(p)) add(i, i, { absolve: 'self' });
      else if (!isBloodlust(p) && afflictedNeighbours(b, i).length) add(i, i, { absolve: 'adj' });
    }
    return out;
  }

  // Ends colour c's turn: devastated pieces of c (except `skip`, freshly devastated)
  // count down, and take their own lives at zero.
  function endTurn(n, c, skip, test) {
    if (!test) for (let i = 0; i < 64; i++) {
      const p = n.board[i];
      if (!p || p.c !== c || !p.dev || i === skip) continue;
      if (--p.dev === 0) { n.board[i] = null; n._info.suicides.push({ sq: i, piece: p }); }
    }
    n.phase = 'move'; n.pending = -1;
    if (c === 'b') n.full++;
    n.turn = opp(c);
    return n;
  }

  // Applies an action, returns new state (does not mutate input). `test` skips
  // end-of-turn suicides (used for the own-king-safety legality check).
  function apply(s, m, test) {
    const n = clone(s), b = n.board, c = s.turn;
    const info = n._info = { captured: null, cured: [], suicides: [], roll: 0, reaction: null, sq: -1 };
    const cure = (sq) => {
      for (const i of afflictedNeighbours(b, sq)) { b[i].r = false; b[i].dev = 0; info.cured.push(i); }
    };

    if (m.roll) {
      const sq = s.pending, p = b[sq];
      info.roll = m.roll; info.reaction = reaction(m.roll); info.sq = sq;
      if (m.roll === 1) p.dev = DEV_TURNS;
      else if (m.roll <= 3) p.r = true;
      else if (m.roll === 6) { p.psy = true; p.k = 1; }   // only kills as a psycho count toward bloodlust
      if (p.t === 'B' && m.roll >= 4) cure(sq);          // a healthy bishop absolves on arrival
      return endTurn(n, c, m.roll === 1 ? sq : -1, test);
    }

    if (m.absolve) {
      const cured = m.absolve === 'self' ? [m.from] : afflictedNeighbours(b, m.from);
      for (const i of cured) { b[i].r = false; b[i].dev = 0; }
      info.cured = cured;
      n.ep = -1; n.half = s.half + 1;
      return endTurn(n, c, -1, test);
    }

    const p = b[m.from];
    const captured = m.ep ? b[(m.from >> 3) * 8 + (m.to & 7)] : b[m.to];
    if (m.ep) b[(m.from >> 3) * 8 + (m.to & 7)] = null;
    b[m.to] = p; b[m.from] = null;
    if (m.promo) p.t = m.promo;
    if (m.castle) {
      const row = m.from >> 3;
      if (m.castle === 'K') { b[row * 8 + 5] = b[row * 8 + 7]; b[row * 8 + 7] = null; }
      else { b[row * 8 + 3] = b[row * 8]; b[row * 8] = null; }
    }
    if (p.t === 'K') { n.castle[c + 'K'] = false; n.castle[c + 'Q'] = false; }
    for (const [sq, key] of [[0, 'wQ'], [7, 'wK'], [56, 'bQ'], [63, 'bK']])
      if (m.from === sq || m.to === sq) n.castle[key] = false;
    n.ep = m.dbl ? (m.from + m.to) / 2 : -1;
    n.half = captured || s.board[m.from].t === 'P' ? 0 : s.half + 1;
    info.captured = captured;

    const awaitsRoll = !!captured && s.remorse && !p.psy;
    if (s.remorse && p.t === 'B' && !afflicted(p) && !awaitsRoll) cure(m.to);
    if (!captured || !s.remorse) return endTurn(n, c, -1, test);

    p.k++;
    if (awaitsRoll) { n.phase = 'roll'; n.pending = m.to; return n; }
    if (s.phase === 'bonus') return endTurn(n, c, -1, test);   // bonus moves don't chain
    n.phase = 'bonus'; n.pending = m.to;                        // psycho kill: move again
    if (!test && !legalMoves(n).length) return endTurn(n, c, -1, test);
    return n;
  }

  function legalMoves(s) {
    const c = s.turn;
    return pseudo(s).filter((m) => m.roll || !inCheck(apply(s, m, true), c));
  }

  function insufficient(s) {
    const pcs = s.board.filter(Boolean).filter((p) => p.t !== 'K');
    if (pcs.length === 0) return true;
    if (pcs.length === 1 && 'BN'.includes(pcs[0].t)) return true;
    return false;
  }

  function key(s) {
    const flag = (p) => (p.r ? '!' : '') + (p.dev ? 'd' + p.dev : '') + (p.psy ? 'p' + Math.min(p.k, BLOODLUST_KILLS) : '');
    return s.board.map((p) => (p ? p.c + p.t + flag(p) : '.')).join('') + s.turn + s.phase + s.pending +
      Object.values(s.castle).map(Number).join('') + (s.ep >= 0 && legalMoves(s).some((m) => m.ep) ? s.ep : '-');
  }

  // Status: {over, winner, reason} | {over:false, check}
  function status(s, history) {
    for (const c of ['w', 'b']) if (kingSq(s, c) < 0) return { over: true, winner: opp(c), reason: 'royal suicide' };
    const moves = legalMoves(s);
    if (!moves.length) {
      if (inCheck(s, s.turn)) return { over: true, winner: opp(s.turn), reason: 'checkmate' };
      return { over: true, winner: null, reason: 'stalemate' };
    }
    if (s.phase !== 'move') return { over: false, check: false };
    if (insufficient(s)) return { over: true, winner: null, reason: 'insufficient material' };
    if (s.half >= 100) return { over: true, winner: null, reason: '50-move rule' };
    if (history) {
      const k = key(s);
      if (history.filter((h) => h === k).length >= 3) return { over: true, winner: null, reason: 'threefold repetition' };
    }
    return { over: false, check: inCheck(s, s.turn) };
  }

  const DIE = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
  const REACT = { devastated: 'devastated', remorseful: 'remorse', unaffected: 'unfazed', psycho: 'psycho' };

  function san(s, m, moves) {
    if (m.roll) return DIE[m.roll] + ' ' + REACT[reaction(m.roll)] + suffix(s, m);
    const p = s.board[m.from];
    if (m.absolve) return 'B' + sqName(m.from) + (m.absolve === 'self' ? ' repents' : ' absolves') + suffix(s, m);
    if (m.castle) return (m.castle === 'K' ? 'O-O' : 'O-O-O') + suffix(s, m);
    let t = p.t === 'P' ? '' : p.t;
    if (p.t !== 'P') {
      const others = (moves || legalMoves(s)).filter((o) => o.from !== m.from && !o.roll && !o.absolve && o.to === m.to && s.board[o.from].t === p.t);
      if (others.length) {
        const sf = others.every((o) => (o.from & 7) !== (m.from & 7));
        const sr = others.every((o) => (o.from >> 3) !== (m.from >> 3));
        t += sf ? sqName(m.from)[0] : sr ? sqName(m.from)[1] : sqName(m.from);
      }
    } else if (m.cap) t = sqName(m.from)[0];
    return t + (m.cap ? 'x' : '') + sqName(m.to) + (m.promo ? '=' + m.promo : '') + suffix(s, m);
  }
  // Check marks only once the turn is over (a pending roll can still cancel a check).
  function suffix(s, m) {
    const n = apply(s, m);
    let out = '';
    if (n.turn !== s.turn) {
      const chk = inCheck(n, n.turn);
      out = chk ? (legalMoves(n).length ? '+' : '#') : '';
    }
    for (const x of n._info.suicides) out += ' ' + x.piece.t + sqName(x.sq) + '☠';
    return out;
  }

  function perft(s, d) {
    if (d === 0) return 1;
    let n = 0;
    for (const m of legalMoves(s)) n += d === 1 ? 1 : perft(apply(s, m), d - 1);
    return n;
  }

  const api = {
    newGame, clone, legalMoves, apply, status, san, key, inCheck, attacked, perft, sqName, opp,
    reaction, isBloodlust, afflicted, DIE, DEV_TURNS, BLOODLUST_KILLS,
  };
  if (typeof module !== 'undefined') module.exports = api;
  else root.Remorse = api;
})(this);
