/* Remorse Chess engine.
 * Standard chess + remorse: a piece that captures becomes remorseful and cannot
 * capture (nor give check) until a bishop moves orthogonally next to it.
 * Board: array of 64, index = rank*8 + file, rank 0 = White's back rank (a1 = 0).
 * Piece: {t:'PNBRQK', c:'w'|'b', r:boolean}
 */
(function (root) {
  const KN = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
  const KG = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const DG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const OR = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  const inb = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;
  const opp = (c) => (c === 'w' ? 'b' : 'w');
  const sqName = (i) => 'abcdefgh'[i & 7] + ((i >> 3) + 1);

  function newGame(opts) {
    const b = new Array(64).fill(null);
    const back = 'RNBQKBNR';
    for (let f = 0; f < 8; f++) {
      b[f] = { t: back[f], c: 'w', r: false };
      b[8 + f] = { t: 'P', c: 'w', r: false };
      b[48 + f] = { t: 'P', c: 'b', r: false };
      b[56 + f] = { t: back[f], c: 'b', r: false };
    }
    return {
      board: b, turn: 'w',
      castle: { wK: true, wQ: true, bK: true, bQ: true },
      ep: -1, half: 0, full: 1,
      remorse: !opts || opts.remorse !== false,
    };
  }

  function clone(s) {
    return {
      board: s.board.map((p) => (p ? { t: p.t, c: p.c, r: p.r } : null)),
      turn: s.turn, castle: { ...s.castle }, ep: s.ep, half: s.half, full: s.full, remorse: s.remorse,
    };
  }

  // Is square `sq` attacked by color `by`? Remorseful pieces attack nothing.
  function attacked(s, sq, by) {
    const b = s.board, f = sq & 7, r = sq >> 3;
    const live = (p, ts) => p && p.c === by && !(s.remorse && p.r) && ts.includes(p.t);
    // pawns
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

  // Pseudo-legal moves. Move: {from,to,promo?,cap?,ep?,castle?}
  function pseudo(s) {
    const b = s.board, c = s.turn, out = [];
    const add = (from, to, extra) => out.push(Object.assign({ from, to }, extra));
    for (let i = 0; i < 64; i++) {
      const p = b[i];
      if (!p || p.c !== c) continue;
      const f = i & 7, r = i >> 3;
      const canCap = !(s.remorse && p.r);
      if (p.t === 'P') {
        const d = c === 'w' ? 1 : -1, start = c === 'w' ? 1 : 6, last = c === 'w' ? 7 : 0;
        const push = (to, extra) => {
          if ((to >> 3) === last) for (const pr of 'QRBN') add(i, to, Object.assign({ promo: pr }, extra));
          else add(i, to, extra);
        };
        if (inb(f, r + d) && !b[(r + d) * 8 + f]) {
          push((r + d) * 8 + f);
          if (r === start && !b[(r + 2 * d) * 8 + f]) add(i, (r + 2 * d) * 8 + f, { dbl: true });
        }
        if (canCap) for (const df of [-1, 1]) {
          if (!inb(f + df, r + d)) continue;
          const to = (r + d) * 8 + f + df, q = b[to];
          if (q && q.c !== c) push(to, { cap: true });
          else if (!q && to === s.ep) add(i, to, { cap: true, ep: true });
        }
      } else if (p.t === 'N' || p.t === 'K') {
        for (const [df, dr] of p.t === 'N' ? KN : KG) {
          if (!inb(f + df, r + dr)) continue;
          const to = (r + dr) * 8 + f + df, q = b[to];
          if (!q) add(i, to);
          else if (q.c !== c && canCap) add(i, to, { cap: true });
        }
        if (p.t === 'K') {
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
            if (!q) add(i, to);
            else { if (q.c !== c && canCap) add(i, to, { cap: true }); break; }
            x += df; y += dr;
          }
        }
      }
    }
    return out;
  }

  // Applies move, returns new state (does not mutate input).
  function apply(s, m) {
    const n = clone(s), b = n.board, p = b[m.from], c = s.turn;
    const captured = m.ep ? b[(m.from >> 3) * 8 + (m.to & 7)] : b[m.to];
    if (m.ep) b[(m.from >> 3) * 8 + (m.to & 7)] = null;
    b[m.to] = p; b[m.from] = null;
    if (m.promo) p.t = m.promo;
    if (m.castle) {
      const row = m.from >> 3;
      if (m.castle === 'K') { b[row * 8 + 5] = b[row * 8 + 7]; b[row * 8 + 7] = null; }
      else { b[row * 8 + 3] = b[row * 8]; b[row * 8] = null; }
    }
    if (captured) p.r = true; // remorse!
    // rights
    if (p.t === 'K') { n.castle[c + 'K'] = false; n.castle[c + 'Q'] = false; }
    for (const [sq, key] of [[0, 'wQ'], [7, 'wK'], [56, 'bQ'], [63, 'bK']])
      if (m.from === sq || m.to === sq) n.castle[key] = false;
    n.ep = m.dbl ? (m.from + m.to) / 2 : -1;
    // cure: a bishop landing orthogonally next to remorseful pieces
    const cured = [];
    if (s.remorse && p.t === 'B') {
      const f = m.to & 7, r = m.to >> 3;
      for (const [df, dr] of OR) {
        if (!inb(f + df, r + dr)) continue;
        const q = b[(r + dr) * 8 + f + df];
        if (q && q.r) { q.r = false; cured.push((r + dr) * 8 + f + df); }
      }
    }
    n.half = captured || s.board[m.from].t === 'P' ? 0 : s.half + 1;
    if (c === 'b') n.full++;
    n.turn = opp(c);
    n._info = { captured, cured };
    return n;
  }

  function legalMoves(s) {
    const c = s.turn;
    return pseudo(s).filter((m) => !inCheck(apply(s, m), c));
  }

  function insufficient(s) {
    const pcs = s.board.filter(Boolean).filter((p) => p.t !== 'K');
    if (pcs.length === 0) return true;
    if (pcs.length === 1 && 'BN'.includes(pcs[0].t)) return true;
    return false;
  }

  function key(s) {
    return s.board.map((p) => (p ? p.c + p.t + (p.r ? '!' : '') : '.')).join('') +
      s.turn + Object.values(s.castle).map(Number).join('') + (s.ep >= 0 && legalMoves(s).some((m) => m.ep) ? s.ep : '-');
  }

  // Status: {over, result, reason}
  function status(s, history) {
    const moves = legalMoves(s);
    if (!moves.length) {
      if (inCheck(s, s.turn)) return { over: true, winner: opp(s.turn), reason: 'checkmate' };
      return { over: true, winner: null, reason: 'stalemate' };
    }
    if (insufficient(s)) return { over: true, winner: null, reason: 'insufficient material' };
    if (s.half >= 100) return { over: true, winner: null, reason: '50-move rule' };
    if (history) {
      const k = key(s);
      if (history.filter((h) => h === k).length >= 3) return { over: true, winner: null, reason: 'threefold repetition' };
    }
    return { over: false, check: inCheck(s, s.turn) };
  }

  function san(s, m, moves) {
    const p = s.board[m.from];
    if (m.castle) return (m.castle === 'K' ? 'O-O' : 'O-O-O') + suffix(s, m);
    let t = p.t === 'P' ? '' : p.t;
    if (p.t !== 'P') {
      const others = (moves || legalMoves(s)).filter((o) => o !== m && o.to === m.to && s.board[o.from].t === p.t);
      if (others.length) {
        const sf = others.every((o) => (o.from & 7) !== (m.from & 7));
        const sr = others.every((o) => (o.from >> 3) !== (m.from >> 3));
        t += sf ? sqName(m.from)[0] : sr ? sqName(m.from)[1] : sqName(m.from);
      }
    } else if (m.cap) t = sqName(m.from)[0];
    return t + (m.cap ? 'x' : '') + sqName(m.to) + (m.promo ? '=' + m.promo : '') + suffix(s, m);
  }
  function suffix(s, m) {
    const n = apply(s, m);
    const has = legalMoves(n).length > 0, chk = inCheck(n, n.turn);
    return chk ? (has ? '+' : '#') : '';
  }

  function perft(s, d) {
    if (d === 0) return 1;
    let n = 0;
    for (const m of legalMoves(s)) n += d === 1 ? 1 : perft(apply(s, m), d - 1);
    return n;
  }

  const api = { newGame, clone, legalMoves, apply, status, san, key, inCheck, attacked, perft, sqName, opp };
  if (typeof module !== 'undefined') module.exports = api;
  else root.Remorse = api;
})(this);
