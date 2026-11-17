# Remorse Chess ♝

Chess where every capture leaves the capturing piece full of remorse.

**Play:** https://askretik.github.io/remorse-chess/

## Rules
1. Every rule of chess applies.
2. When a piece captures, it feels **remorse** (shown with a red ring). A remorseful piece cannot capture, and therefore cannot give check either.
3. Remorse is lifted when a **bishop moves to a square orthogonally adjacent** (up/down/left/right, not diagonal) to the remorseful piece. Any bishop works, of either colour. Capture again and the remorse returns.

## How multiplayer works
Click **Yes, generate a game** to get a shareable link. Your friend opens it and joins as the opponent. Moves go directly between browsers (WebRTC via [PeerJS](https://peerjs.com)), so there is no game server. Notes:
- The creator is the host: keep that tab open (reloading is fine, the game is restored from the browser's local storage).
- A third person opening the link can spectate.
- Very strict networks/firewalls may block peer-to-peer connections.

## Development
Static site, no build step: `python3 -m http.server` and open `index.html`. `engine.js` holds the rules (verified against standard chess perft numbers with remorse disabled).

## Credits
Piece graphics: "cburnett" set by Colin M.L. Burnett (GPLv2+ / BSD / GFDL), via Lichess. Board colours follow the familiar green/cream style.
