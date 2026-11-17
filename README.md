# Remorse Chess ♝

Chess where every capture leaves the capturing piece full of remorse.

**Play:** https://askretik.github.io/remorse-chess/

## Rules
1. Every rule of chess applies.
2. After every capture, the killer **rolls a die** to decide how it reacts:
   - **1 · Devastated** (blue ring): it can't live with what it has done. It can't move and gives no check. Absolve it within 3 of its owner's turns, or it takes its own life and leaves the board. A king that does this loses the game.
   - **2–3 · Remorseful** (red ring): it can't capture and gives no check until absolved.
   - **4–5 · Unfazed**: nothing happens.
   - **6 · Psychopath** (purple ring): permanent and incurable, and it never rolls again. Each later capture earns it one mandatory extra move with the same piece (an extra-move capture doesn't earn another). After 3 kills in total (counting the one that rolled the 6) it gets **bloodlust** (pulsing glow): it only moves to capture, and will capture its own pieces too (never a king).
3. **Absolution** cures remorseful and devastated pieces:
   - A healthy bishop of either colour that **moves to a square orthogonally adjacent** (up/down/left/right, not diagonal) to afflicted pieces absolves them instantly, as part of that move. The afflicted piece moving next to a bishop doesn't count. A bishop that captures only absolves if its roll leaves it healthy (4–6).
   - **Absolving in place:** instead of moving, you may spend your turn having one of your own healthy bishops absolve every afflicted piece orthogonally next to it.
   - **Afflicted bishops** can't absolve anyone, but you may spend a turn to have one absolve itself.
4. Kings are never captured, not even by a psychopath's extra move.

## How multiplayer works
Click **Yes, generate a game** to get a shareable link. Your friend opens it and joins as the opponent. Moves (and die rolls, which the host makes so nobody picks their own number) go directly between browsers (WebRTC via [PeerJS](https://peerjs.com)), so there is no game server. Notes:
- The creator is the host: keep that tab open (reloading is fine, the game is restored from the browser's local storage).
- A third person opening the link can spectate.
- Very strict networks/firewalls may block peer-to-peer connections.

## Development
Static site, no build step: `python3 -m http.server` and open `index.html`. `engine.js` holds the rules (verified against standard chess perft numbers with remorse disabled).

## Credits
Piece graphics: "cburnett" set by Colin M.L. Burnett (GPLv2+ / BSD / GFDL), via Lichess. Board colours follow the familiar green/cream style.
