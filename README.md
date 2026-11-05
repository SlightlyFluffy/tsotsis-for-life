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

**Bots:** the host can press **+ Add bot** in the lobby to fill slots. Bots count
towards the 3-player minimum, so you can test solo with 2 bots. They run on the
host and play by the same rules.

### Testing on one machine

Add `?local` to the URL (`http://localhost:8080/?local`). Peers then talk over
`BroadcastChannel` between tabs of the same browser instead of WebRTC, so you
can open 3 tabs and play against yourself with no internet.

## How it plays

| Action | Desktop | Touch |
| --- | --- | --- |
| Move | WASD / arrows | left joystick |
| Run (loud) | Shift | RUN |
| Take out / klap | **left-click the person** | tap the person |
| Kick dust | Q | DUST |
| Help | H | — |
| Full scoreboard | Tab (hold) | — |

**Your moves**

- **Take out:** click your contract while standing next to them. It only works while walking: you can't strike while running or for 1s after.
  Base 100, plus **Low profile** +100 (no running in the last 2s), **Blended in** +150 (you were in a crowd or under a tree), and **Never spotted** +100.
- **Klap:** click someone who is hunting you. +200, and they're stunned and lose their contract.
- **Kick dust (Q):** stuns everyone right next to you for 2.5s. It's your escape when rushed. 20s cooldown, and everyone can see the cloud.
- You always hit exactly who you clicked, never "whoever is nearest". A white ring shows who a click would hit, and clicking someone out of reach does nothing.

**Finding your target**

- From far away the compass is a wide wedge pointing in one of 8 rough directions.
- Within 350px it stops pointing and only pulses, so you have to pick them out by their outfit.
- Watch them from within 110px for 1.5s to **identify** them and get the gold ring. You can't identify someone blending into a crowd or under a tree.

**Penalties and pressure**

- **Wrong person** (a civilian, or a player who is neither your target nor your hunter): −50 points, no strikes for 6s, no new contract for 15s, and the scream reveals you to your hunters for 5s. They get an instant lock on you.
- **Exposure:** running within 220px of your target marks you red on their screen for 3s.
- **The crowd:** there are 36 lookalikes per outfit in play, so 108–180 civilians. Some of them hurry along too, so a fast mover isn't always a player.
- **Hunter warning:** you always see how many people are hunting you and roughly how close the nearest one is, but not who they are.
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
