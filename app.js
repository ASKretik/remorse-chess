/* Remorse Chess – UI + peer-to-peer multiplayer (PeerJS / WebRTC).
 * The creator of a game is the host and is authoritative; the person opening the
 * shared link becomes the opponent. Further visitors are spectators. */
(() => {
  const E = Remorse;
  const $ = (s) => document.querySelector(s);
  const PREFIX = 'remorsechess-';
  const NAMES = { w: 'White', b: 'Black' };

  let id = null;                 // game id (from ?g=)
  let isHost = false;
  let myColor = null;            // 'w' | 'b' | null (spectator)
  let game = { hostColor: 'w', moves: [], resigned: null, guestToken: null };
  let states, sans, keys;        // derived from game.moves
  let view = 0, userFlip = false, selected = -1, legal = [], absMove = null, animatedAt = -1;
  let peer = null, guestConn = null, hostConn = null, conns = [];
  let token = null, retryTimer = null, connText = '';

  const last = () => states.length - 1;
  const cur = () => states[last()];
  const flipped = () => userFlip !== (myColor === 'b');

  /* ---------- helpers ---------- */
  function toast(msg, ms = 2600) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
  }
  const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
  const store = {
    get: (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  const persist = () => isHost && store.set('rc-host-' + id, game);

  const sameMove = (x, mv) => (mv.roll ? x.roll === mv.roll
    : !x.roll && x.from === mv.from && x.to === mv.to && (x.promo || null) === (mv.promo || null));

  function rebuild() {
    states = [E.newGame()]; sans = []; keys = [E.key(states[0])];
    for (let i = 0; i < game.moves.length; i++) {
      const s = cur(), ms = E.legalMoves(s), m = ms.find((x) => sameMove(x, game.moves[i]));
      if (!m) { game.moves = game.moves.slice(0, i); break; }   // e.g. a game saved under older rules
      sans.push(E.san(s, m, ms));
      states.push(E.apply(s, m));
      keys.push(E.key(cur()));
    }
    view = last(); deselect();
  }
  function rollDie() {
    const a = new Uint8Array(1);
    do crypto.getRandomValues(a); while (a[0] >= 252);
    return (a[0] % 6) + 1;
  }
  function deselect() { selected = -1; legal = []; absMove = null; }

  function gameStatus() {
    if (game.resigned) return { over: true, winner: E.opp(game.resigned), reason: 'resignation' };
    return E.status(cur(), keys);
  }

  /* ---------- game actions ---------- */
  function hostApply(color, mv) {
    const st = gameStatus(), s = cur();
    if (st.over || s.turn !== color) return;
    // The host rolls the die, so neither side picks its own number.
    const rec = mv.type === 'roll' ? { roll: rollDie() } : { from: mv.from, to: mv.to, promo: mv.promo || null };
    if (!E.legalMoves(s).some((m) => sameMove(m, rec))) return;
    game.moves.push(rec);
    afterChange();
  }
  function hostResign(color) { if (!gameStatus().over) { game.resigned = color; afterChange(); } }
  function hostRematch() {
    if (!gameStatus().over) return;
    game = { hostColor: E.opp(game.hostColor), moves: [], resigned: null, guestToken: game.guestToken };
    myColor = game.hostColor; userFlip = false;
    afterChange();
  }
  function afterChange() { persist(); rebuild(); broadcast(); render(); actionFx(); }

  function act(msg) {            // called by local UI
    if (isHost) {
      if (msg.type === 'move' || msg.type === 'roll') hostApply(myColor, msg);
      else if (msg.type === 'resign') hostResign(myColor);
      else if (msg.type === 'rematch') hostRematch();
    } else if (hostConn && hostConn.open) hostConn.send(msg);
    else toast('Not connected to the host right now.');
  }

  /* ---------- networking ---------- */
  function stateMsg(c) {
    return { type: 'state', hostColor: game.hostColor, moves: game.moves, resigned: game.resigned,
      role: c._isGuest ? E.opp(game.hostColor) : 'spectator' };
  }
  function broadcast() { conns.forEach((c) => c.open && c.send(stateMsg(c))); }

  function startHost() {
    isHost = true; myColor = game.hostColor;
    connText = 'Starting…';
    const open = () => {
      peer = new Peer(PREFIX + id);
      peer.on('open', () => { connText = ''; render(); });
      peer.on('connection', onGuestConn);
      peer.on('disconnected', () => { try { peer.reconnect(); } catch {} });
      peer.on('error', (e) => {
        if (e.type === 'unavailable-id') {
          connText = 'Reclaiming this game… (is it open in another tab?)';
          peer.destroy(); setTimeout(open, 3000);
        } else if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error') {
          connText = 'Network trouble — retrying…';
        } else console.warn(e);
        render();
      });
    };
    open();
  }

  function onGuestConn(c) {
    conns.push(c);
    c.on('data', (d) => {
      if (!d || typeof d !== 'object') return;
      if (d.type === 'hello') {
        if (!game.guestToken) { game.guestToken = String(d.token); persist(); }
        c._isGuest = String(d.token) === game.guestToken;
        if (c._isGuest) {
          const old = guestConn; guestConn = c;
          if (old && old !== c) old.close();
          toast('Your opponent joined!');
        }
        c.send(stateMsg(c)); render();
      } else if (c._isGuest) {
        const col = E.opp(game.hostColor);
        if (d.type === 'move') hostApply(col, { from: d.from | 0, to: d.to | 0, promo: d.promo || null });
        else if (d.type === 'roll') hostApply(col, { type: 'roll' });
        else if (d.type === 'resign') hostResign(col);
        else if (d.type === 'rematch') hostRematch();
      }
    });
    c.on('close', () => { conns = conns.filter((x) => x !== c); if (guestConn === c) { guestConn = null; toast('Opponent disconnected.'); } render(); });
  }

  function startGuest() {
    isHost = false;
    token = store.get('rc-guest-' + id);
    if (!token) { token = rid() + rid(); store.set('rc-guest-' + id, token); }
    connText = 'Connecting to host…';
    peer = new Peer();
    peer.on('open', connect);
    peer.on('error', (e) => {
      if (e.type === 'peer-unavailable') { connText = 'Host is offline — waiting for them to open the link…'; retry(); }
      else if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error') { connText = 'Network trouble — retrying…'; retry(); }
      else console.warn(e);
      render();
    });
    peer.on('disconnected', () => { try { peer.reconnect(); } catch {} });
  }
  function retry() { clearTimeout(retryTimer); retryTimer = setTimeout(connect, 3000); }
  function connect() {
    if (!peer || peer.destroyed || (hostConn && hostConn.open)) return;
    const c = peer.connect(PREFIX + id, { reliable: true });
    hostConn = c;
    c.on('open', () => { c.send({ type: 'hello', token }); connText = ''; render(); });
    c.on('data', (d) => {
      if (d && d.type === 'state') {
        const oldLen = game.moves.length;
        game = { hostColor: d.hostColor, moves: d.moves, resigned: d.resigned };
        const newRole = d.role === 'spectator' ? null : d.role;
        if (newRole !== myColor) userFlip = false;
        myColor = newRole;
        rebuild(); render();
        if (d.moves.length > oldLen) actionFx();
      }
    });
    c.on('close', () => { connText = 'Host went offline — reconnecting…'; hostConn = null; retry(); render(); });
    setTimeout(() => { if (hostConn === c && !c.open) { c.close(); hostConn = null; retry(); } }, 9000);
  }

  /* ---------- effects for the newest action ---------- */
  const PIECE = { P: 'pawn', N: 'knight', B: 'bishop', R: 'rook', Q: 'queen', K: 'king' };
  const REACTION = {
    devastated: { label: 'Devastated', text: `can't live with what it has done and won't move. Absolve it within ${E.DEV_TURNS} turns or it will end itself.` },
    remorseful: { label: 'Remorseful', text: 'is full of remorse: no captures, no check until a bishop absolves it.' },
    unaffected: { label: 'Unfazed', text: 'shrugs it off and carries on.' },
    psycho: { label: 'Psychopath', text: `has discovered it enjoys killing. Every kill earns it another move, and after ${E.BLOODLUST_KILLS} kills it craves blood.` },
  };
  let dieSpinUntil = 0;

  function actionFx() {
    const s = cur(), info = s._info, mv = game.moves[game.moves.length - 1];
    if (!info || !mv) return;
    if (info.roll) spinDie();
    if (info.cured.length) {
      if (mv.from === mv.to && info.cured.length === 1 && info.cured[0] === mv.from) toast('The bishop absolved itself.');
      else toast('A bishop lifted the remorse!');
    }
    if (!mv.roll && mv.from !== mv.to && info.captured) {
      const p = s.board[mv.to];
      if (p && p.psy && p.k === E.BLOODLUST_KILLS) toast(`Bloodlust! This ${PIECE[p.t]} now only moves to kill, friend or foe.`, 4000);
      else if (s.phase === 'bonus') toast(s.turn === myColor ? 'Psycho kill! It must move again.' : `${NAMES[s.turn]}'s psycho moves again…`);
    }
    for (const x of info.suicides) {
      suicideFx(x.sq, x.piece);
      toast(`The ${NAMES[x.piece.c].toLowerCase()} ${PIECE[x.piece.t]} on ${E.sqName(x.sq)} couldn't live with itself. 💀`, 4000);
    }
  }

  function spinDie() {
    dieSpinUntil = Date.now() + 750;
    const face = $('#dieFace'), tick = () => {
      if (Date.now() >= dieSpinUntil) { face.classList.remove('spin'); return render(); }
      face.textContent = E.DIE[1 + ((Math.random() * 6) | 0)];
      setTimeout(tick, 70);
    };
    face.classList.add('spin'); tick();
  }

  function suicideFx(sq, p) {
    const fl = flipped(), row = fl ? sq >> 3 : 7 - (sq >> 3), col = fl ? 7 - (sq & 7) : sq & 7;
    const el = document.createElement('div');
    el.className = 'suicide';
    el.style.left = col * 12.5 + '%'; el.style.top = row * 12.5 + '%';
    const img = `<img src="pieces/${p.c}${p.t}.svg" alt="">`;
    el.innerHTML = `<div class="body">${img}</div><div class="ghost">${img}</div><div class="skull">💀</div>`;
    $('#fx').appendChild(el);
    setTimeout(() => el.remove(), 2800);
  }

  /* ---------- rendering ---------- */
  function render() {
    if (!states) return;
    const s = states[view], st = gameStatus(), live = view === last();
    const fl = flipped();
    const board = $('#board'); board.innerHTML = '';
    let lmi = view - 1;
    while (lmi >= 0 && game.moves[lmi].roll) lmi--;        // highlight the last board move, not a roll
    const lm = lmi >= 0 ? game.moves[lmi] : null;
    const myTurn = live && !st.over && myColor === s.turn;
    if (myTurn && s.phase === 'bonus' && selected !== s.pending) {   // the psycho must move: preselect it
      selected = s.pending; legal = E.legalMoves(s); absMove = null;
    }
    const kSq = s.board.findIndex((p) => p && p.t === 'K' && p.c === s.turn);
    const showCheck = view > 0 && E.inCheck(s, s.turn);
    const curedNow = view > 0 && view !== animatedAt ? states[view]._info.cured : [];
    const absNow = myTurn ? E.legalMoves(s).filter((m) => m.absolve).map((m) => m.from) : [];
    const absTargets = absMove ? (absMove.absolve === 'self' ? [absMove.from] : E.apply(s, absMove)._info.cured) : [];

    for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) {
      const rank = fl ? row : 7 - row, file = fl ? 7 - col : col, sq = rank * 8 + file;
      const el = document.createElement('div');
      el.className = 'sq ' + ((rank + file) % 2 ? 'l' : 'd');
      if (lm && (sq === lm.from || sq === lm.to)) el.classList.add('hl');
      if (sq === selected) el.classList.add('sel');
      if (showCheck && sq === kSq) el.classList.add('check');
      const p = s.board[sq];
      if (myTurn && p && p.c === myColor) el.classList.add('mine');
      const mv = legal.find((m) => m.to === sq);
      if (mv) { el.classList.add(mv.cap ? 'capt' : 'mv'); el.classList.add('mine'); }
      if (col === 0) el.insertAdjacentHTML('beforeend', `<span class="rk">${rank + 1}</span>`);
      if (row === 7) el.insertAdjacentHTML('beforeend', `<span class="fl">${'abcdefgh'[file]}</span>`);
      if (p) {
        el.insertAdjacentHTML('beforeend', `<img class="pc" draggable="false" src="pieces/${p.c}${p.t}.svg" alt="${p.c}${p.t}">`);
        const ring = p.dev ? ['dev', `Devastated — can't move; ${p.dev} turn${p.dev > 1 ? 's' : ''} left to absolve it`]
          : p.r ? ['rem', 'Remorseful — cannot capture']
          : E.isBloodlust(p) ? ['blood', 'Bloodlust — only moves to capture, friend or foe']
          : p.psy ? ['psy', `Psychopath — ${p.k} kill${p.k > 1 ? 's' : ''}; extra move after each kill`] : null;
        if (ring) el.insertAdjacentHTML('beforeend', `<div class="ring ${ring[0]}" title="${ring[1]}"></div>`);
        if (p.dev) el.insertAdjacentHTML('beforeend', `<span class="devn" title="${ring[1]}">${p.dev}</span>`);
      }
      if (curedNow.includes(sq)) el.classList.add('cured');
      if (absNow.includes(sq) && sq !== selected) el.classList.add('canabs');
      if (absTargets.includes(sq)) el.classList.add('abstgt');
      el.onclick = () => clickSq(sq);
      board.appendChild(el);
    }
    animatedAt = view;

    // player bars
    const topC = fl ? 'w' : 'b', botC = E.opp(topC);
    const capOf = (color) => {
      const out = [];
      for (let i = 1; i <= view; i++) { const c = states[i]._info.captured; if (c && c.c !== color) out.push(c); }
      return out.map((p) => `<img src="pieces/${p.c}${p.t}.svg" alt="">`).join('');
    };
    const online = (c) => (isHost ? (c === game.hostColor ? true : !!(guestConn && guestConn.open)) : (c === myColor ? !!(hostConn && hostConn.open) : !!(hostConn && hostConn.open)));
    const bar = (c) => `<span class="dot ${online(c) ? 'on' : ''}"></span>${NAMES[c]}${c === myColor ? ' (you)' : ''}<span class="cap">${capOf(c)}</span>`;
    $('#barTop').innerHTML = bar(topC); $('#barBot').innerHTML = bar(botC);

    // status
    const sl = $('#statusLine'); sl.className = 'status';
    if (st.over) {
      sl.classList.add('over');
      sl.textContent = st.winner ? `${NAMES[st.winner]} wins by ${st.reason}` : `Draw — ${st.reason}`;
    } else {
      const c = cur(), mine = myColor === c.turn;
      const chk = c.phase === 'move' && E.inCheck(c, c.turn) ? ' — check!' : '';
      if (c.phase === 'roll') sl.textContent = mine ? 'Roll the die!' : `${NAMES[c.turn]} is rolling…`;
      else if (c.phase === 'bonus') sl.textContent = mine ? 'Psycho bonus move!' : `${NAMES[c.turn]}'s psycho moves again…`;
      else sl.textContent = myColor ? (mine ? 'Your move' : `Waiting for ${NAMES[c.turn]}`) + chk : `${NAMES[c.turn]} to move` + chk;
    }
    renderDice(s, myTurn);
    let cl = connText;
    if (!cl && isHost) cl = guestConn && guestConn.open ? 'Opponent connected' : 'Waiting for your opponent to open the link…';
    if (!cl && !isHost) cl = myColor ? 'Connected to host' : 'Connected — spectating';
    $('#connLine').textContent = cl;
    $('#share').hidden = !isHost;
    $('#shareUrl').value = location.href;

    // move list
    // move list: one cell per turn; a turn can hold a capture, its roll and a psycho's bonus move
    const mvl = $('#moves'); mvl.innerHTML = '';
    let cell = null;
    sans.forEach((san, i) => {
      const before = states[i];
      if (before.phase === 'move' || !cell) {
        if (before.turn === 'w') mvl.insertAdjacentHTML('beforeend', `<span class="n">${before.full}.</span>`);
        cell = document.createElement('span'); cell.className = 'mc'; mvl.appendChild(cell);
      }
      const d = document.createElement('span');
      d.className = 'm' + (i + 1 === view ? ' cur' : '') + (game.moves[i].roll ? ' roll' : ''); d.textContent = san;
      d.onclick = () => go(i + 1);
      cell.appendChild(d);
    });
    mvl.scrollTop = mvl.scrollHeight;
    const ab = $('#absolveBtn');
    ab.hidden = !absMove;
    if (absMove) ab.textContent = absMove.absolve === 'self'
      ? 'Absolve this bishop (uses your turn)'
      : `Absolve ${absTargets.length > 1 ? absTargets.length + ' pieces' : 'neighbour'} (uses your turn)`;
    $('#resignBtn').hidden = st.over || !myColor;
    $('#rematchBtn').hidden = !st.over || !myColor;
    $('#firstBtn').disabled = $('#prevBtn').disabled = view === 0;
    $('#nextBtn').disabled = $('#lastBtn').disabled = live;
    document.title = (myTurn ? '● ' : '') + 'Remorse Chess';
  }

  function renderDice(s, myTurn) {
    const box = $('#dice'), face = $('#dieFace'), txt = $('#dieText'), btn = $('#rollBtn');
    const info = s._info, spinning = Date.now() < dieSpinUntil && view === last();
    box.className = 'dice'; btn.hidden = true;
    if (s.phase === 'roll') {
      const p = s.board[s.pending];
      box.hidden = false; face.textContent = '?';
      txt.textContent = myTurn ? `Your ${PIECE[p.t]} has blood on its hands. Roll to see how it takes it.`
        : `${NAMES[s.turn]}'s ${PIECE[p.t]} has blood on its hands…`;
      btn.hidden = !myTurn;
    } else if (info && info.roll) {
      box.hidden = false;
      if (spinning) { txt.textContent = 'Rolling…'; return; }
      const r = REACTION[info.reaction], p = s.board[info.sq];
      face.textContent = E.DIE[info.roll];
      box.classList.add(info.reaction);
      txt.innerHTML = `<b>${info.roll} — ${r.label}</b><br>The ${PIECE[p.t]} ${r.text}`;
    } else box.hidden = true;
  }

  function go(i) { view = Math.max(0, Math.min(last(), i)); deselect(); animatedAt = -1; render(); }

  function clickSq(sq) {
    const s = cur();
    if (view !== last() || gameStatus().over || myColor !== s.turn) return;
    if (s.phase === 'roll') return toast('Roll the die first!');
    const hit = legal.filter((m) => m.to === sq);
    if (selected >= 0 && hit.length) {
      if (hit[0].promo) return askPromo(hit);
      return play(hit[0]);
    }
    if (s.phase === 'bonus') return toast('Your psycho must make its bonus move.');
    const p = s.board[sq];
    if (p && p.c === myColor && sq !== selected) {
      const mine = E.legalMoves(s).filter((m) => m.from === sq);
      selected = sq; legal = mine.filter((m) => !m.absolve); absMove = mine.find((m) => m.absolve) || null;
      const turns = `${p.dev} turn${p.dev > 1 ? 's' : ''}`;
      if (p.dev && p.t === 'B') toast(`This bishop is devastated and can't move, but it can absolve itself (${turns} left).`);
      else if (p.dev) toast(`This ${PIECE[p.t]} is devastated and can't move. A bishop must absolve it within ${turns}.`);
      else if (p.r && p.t === 'B') toast('This bishop feels remorse — it can\'t capture or absolve others until it absolves itself.');
      else if (p.r) toast('This piece feels remorse — it can\'t capture until a bishop absolves it.');
      else if (E.isBloodlust(p)) toast('Bloodlust: this piece only moves to capture — friend or foe.');
    } else deselect();
    render();
  }
  function play(m) { deselect(); act({ type: 'move', from: m.from, to: m.to, promo: m.promo || null }); if (!isHost) render(); }
  function askPromo(opts) {
    const box = $('#promoBox'); box.innerHTML = '';
    opts.forEach((m) => {
      const b = document.createElement('button');
      b.innerHTML = `<img src="pieces/${myColor}${m.promo}.svg" alt="${m.promo}">`;
      b.onclick = () => { $('#promo').hidden = true; play(m); };
      box.appendChild(b);
    });
    $('#promo').hidden = false;
  }

  /* ---------- wiring ---------- */
  $('#firstBtn').onclick = () => go(0);
  $('#prevBtn').onclick = () => go(view - 1);
  $('#nextBtn').onclick = () => go(view + 1);
  $('#lastBtn').onclick = () => go(last());
  $('#flipBtn').onclick = () => { userFlip = !userFlip; render(); };
  $('#absolveBtn').onclick = () => absMove && play(absMove);
  $('#rollBtn').onclick = () => act({ type: 'roll' });   // the host ignores repeats once rolled
  $('#resignBtn').onclick = () => confirm('Resign this game?') && act({ type: 'resign' });
  $('#rematchBtn').onclick = () => act({ type: 'rematch' });
  $('#copyBtn').onclick = async () => {
    try { await navigator.clipboard.writeText(location.href); toast('Link copied!'); }
    catch { $('#shareUrl').select(); toast('Press Ctrl/Cmd+C to copy'); }
  };
  $('#promo').onclick = (e) => { if (e.target.id === 'promo') $('#promo').hidden = true; };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') go(view - 1); else if (e.key === 'ArrowRight') go(view + 1);
  });

  function showGame() { $('#lobby').hidden = true; $('#game').hidden = false; rebuild(); render(); }

  $('#createBtn').onclick = () => {
    const pick = document.querySelector('input[name=col]:checked').value;
    id = rid();
    game = { hostColor: pick === 'r' ? (Math.random() < .5 ? 'w' : 'b') : pick, moves: [], resigned: null, guestToken: null };
    store.set('rc-host-' + id, game);
    history.replaceState(null, '', location.pathname + '?g=' + id);
    showGame(); startHost();
  };

  (function init() {
    if (typeof Peer === 'undefined') {
      const f = $('#fatal'); f.hidden = false; $('#lobby').hidden = true;
      f.innerHTML = '<h2>Couldn\'t load the networking library</h2><p>Check your internet connection and reload.</p>';
      return;
    }
    const g = new URLSearchParams(location.search).get('g');
    if (!g) return;                      // show lobby
    if (!/^[a-z0-9]{6,16}$/i.test(g)) { history.replaceState(null, '', location.pathname); return; }
    id = g;
    const saved = store.get('rc-host-' + id);
    if (saved) { game = saved; showGame(); startHost(); }
    else { showGame(); startGuest(); }
  })();
})();
