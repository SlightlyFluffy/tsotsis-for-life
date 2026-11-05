# Tsotsi's For Life

A peer-to-peer social stealth game for **3–5 players**, played in the browser.

Everyone gets a contract on another player, and someone else has a contract on
them. The kasi is full of people wearing exactly the same look as each player.
Walk like a local, find your mark in the crowd, and take them out before your
own hunter finds you.

## Running it

It's a static site with no build step and no server code. Serve the folder with
any static file server:

```bash
cd tsotsis-for-life
python3 -m http.server 8080
```

Then open `http://localhost:8080`. To play with friends, host the folder
anywhere static (Vercel, Netlify, GitHub Pages, …) and share the URL.

1. One player clicks **Host a game** and gets a 4-letter room code and invite link.
2. Everyone else enters the code (or opens the link) and clicks **Join**.
3. Once 3–5 players are in, the host presses **Start game**.

### Testing on one machine

Add `?local` to the URL (`http://localhost:8080/?local`). Peers then talk over
`BroadcastChannel` between tabs of the same browser instead of WebRTC, so you
can open 3 tabs and play against yourself with no internet.

## How it plays

| Action | Keys | Touch |
| --- | --- | --- |
| Move | WASD / arrows | left joystick |
| Sprint | Shift | RUN |
| Take out / klap | E or Space | KLAP |
| Full scoreboard | Tab (hold) | — |

- **Compass**: the arc around you points at your target and narrows as you get closer.
- **Lock**: inside 150px your target gets a gold ring (only 70px if they're blending in).
- **Take out** your target: 100, plus **Low profile** +100 (you didn't sprint in the last 2s), **Blended in** +150 (you were in a crowd or under a tree), and **Never spotted** +100.
- **Klap** (stun) a player who is hunting you: +200. They're stunned and lose their contract.
- **Wrong person**: hitting a civilian or anyone who isn't your target or hunter costs you your contract and freezes your actions for 2s.
- **Exposure**: sprinting within 220px of your target marks you red on their screen for 3s.
- **Hunter warning**: you always see how many people are hunting you and roughly how close the nearest one is, but not who they are.
- At most 2 hunters per player. You respawn 5s after being taken out.

## Architecture

```
index.html, style.css
js/shared.js   constants, the five looks, seeded map generation, collision
js/net.js      transports: PeerJS/WebRTC ("peer") and BroadcastChannel ("local")
js/host.js     authoritative simulation that only the host runs
js/client.js   input, client-side prediction, interpolation, HUD (every peer)
js/render.js   canvas renderer
js/main.js     menu, lobby, session wiring
js/vendor/peerjs.min.js   PeerJS 1.5.4 (MIT), vendored
```

- **Peer to peer.** There's no game server. The public PeerJS broker is only
  used to introduce browsers to each other; after that, all traffic goes over
  direct WebRTC data channels. The topology is a star: the host's browser runs
  the simulation and the other players connect to it.
- **Host-authoritative.** The host simulates the crowd, contracts, hits and
  scoring at 20 Hz. Clients predict their own movement for responsiveness, and
  the host caps any move at sprint speed and checks it against the walls.
- **No identity leaks.** Every body in the crowd, players and NPCs alike, has
  a random ID, and the list is sorted by ID. Each client gets its own snapshot
  that only says which body is its target once that target is locked, and
  which bodies are exposed hunters. A curious player reading network traffic
  can't pick players out of the crowd. The host's own browser can see
  everything, though, so play with people you trust to host.
- Map layout is generated from a seed, so the host only has to send one number.

### Known limitations

- If the host leaves, the round ends for everyone (no host migration yet).
- Some strict corporate or mobile-carrier NATs block direct WebRTC. Fixing that
  needs a TURN relay server, which you can add through the `config.iceServers`
  option in `js/net.js`.
- Players can't join a round that's already running. They join the next one
  from the lobby.
