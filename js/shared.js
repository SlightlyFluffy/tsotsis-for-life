/* Tsotsi's For Life — shared constants, map generation and physics.
 * Loaded by every peer. Map generation is deterministic from a seed so the
 * host only has to send one number for everyone to build the same kasi. */
(function () {
  'use strict';
  const TFL = (window.TFL = window.TFL || {});

  const C = (TFL.C = {
    W: 2400,
    H: 1600,
    RX: [120, 480, 840, 1200, 1560, 1920, 2280], // road centre lines (vertical roads)
    RY: [120, 460, 800, 1140, 1480], // road centre lines (horizontal roads)
    ROAD_HALF: 42,
    TICK_MS: 50,
    WALK: 85,
    SPRINT: 190,
    NPC_MIN: 72,
    NPC_MAX: 96,
    R: 11,
    ACTION_RANGE: 34,
    LOCK_RANGE: 110, // keep eyes on your target this close...
    ID_TIME: 1.5, // ...for this long to identify them (not while they blend in)
    CLOSE_RANGE: 350, // inside this the compass stops pointing
    FAR_RANGE: 700,
    CALM_TIME: 1.0, // seconds after sprinting before you can strike
    DUST_RANGE: 70,
    DUST_STUN: 2.5,
    DUST_CD: 20,
    EXPOSE_RANGE: 220, // sprinting this close to your target exposes you
    EXPOSE_TIME: 3,
    MAX_HUNTERS: 2,
    RESPAWN: 5,
    NEW_CONTRACT: 3,
    WHIFF_CONTRACT: 15,
    WHIFF_COOLDOWN: 6,
    WHIFF_REVEAL: 5,
    WHIFF_POINTS: 1,
    STUN_TIME: 3,
    BUMP_STUN: 1.5,
    NPC_DOWN: 5,
    NPC_PER_STYLE: 36,
    BLEND_RADIUS: 46,
    BLEND_COUNT: 2,
    TREE_COVER: 26,
    MIN_PLAYERS: 3,
    MAX_PLAYERS: 5,
    SCORE: { KILL: 5, POISON: 2, LOW_PROFILE: 1, BLENDED: 2, UNSEEN: 1, STUN: 3 },
    KILL_LOCK: 0.9, // killer is committed to the strike animation
    POISON_TIME: 5,
    POISON_CD: 25,
    CLONE_RANGE: 110,
    CLONE_TIME: 15,
    CLONE_CD: 30,
    DECOY_RANGE: 170,
    DECOY_TIME: 6,
    DECOY_CD: 20,
  });

  // The five looks. Every player wears a different one and the crowd is full
  // of people wearing the same thing.
  TFL.STYLES = [
    { name: 'Red Bucket Hat', shirt: '#c0392b', trim: '#7b1f16', hat: 'bucket', hatColor: '#1d1d1d', pants: '#2b2b33' },
    { name: 'Mustard Ivy Cap', shirt: '#e0a82e', trim: '#8f6a14', hat: 'ivy', hatColor: '#4a3b2a', pants: '#3a3226' },
    { name: 'Blue Beanie', shirt: '#2f6fd6', trim: '#1b438a', hat: 'beanie', hatColor: '#f1f1f1', pants: '#20242c' },
    { name: 'Green Doek', shirt: '#2e9e5b', trim: '#17633a', hat: 'doek', hatColor: '#e67e22', pants: '#3b2f2a' },
    { name: 'Purple Cap', shirt: '#8e44ad', trim: '#5a2a6e', hat: 'cap', hatColor: '#ecf0f1', pants: '#1f1f26' },
  ];

  TFL.SKINS = ['#5a3a24', '#6b4329', '#7d4f30', '#8d5a36', '#4a2f1d', '#9a6a45', '#a87a52'];

  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  TFL.mulberry32 = mulberry32;

  TFL.hash = function (n) {
    n = ((n >>> 16) ^ n) * 0x45d9f3b;
    n = ((n >>> 16) ^ n) * 0x45d9f3b;
    return ((n >>> 16) ^ n) >>> 0;
  };

  // Special blocks, keyed "col,row" (6 x 4 blocks between the roads).
  const SPECIALS = {
    '1,1': 'taxi',
    '4,1': 'market',
    '2,2': 'pitch',
    '3,0': 'spaza',
    '0,2': 'park',
    '5,3': 'shebeen',
  };
  const ZONE_NAMES = {
    taxi: 'TAXI RANK',
    market: 'MARKET',
    pitch: 'DUSTY PITCH',
    spaza: 'SPAZA CORNER',
    park: 'THE PARK',
    shebeen: 'SHEBEEN',
  };

  const ROOFS = ['#8a8f96', '#a0522d', '#5d7f8c', '#7a8b6f', '#b5651d', '#6b6f9c', '#9aa3a8', '#7f5f4a', '#c2b59b'];
  const AWNINGS = ['#d35400', '#16a085', '#c0392b', '#2980b9', '#f1c40f', '#8e44ad'];

  TFL.buildMap = function (seed) {
    const rnd = mulberry32(seed >>> 0);
    const RX = C.RX, RY = C.RY, RH = C.ROAD_HALF;
    const obstacles = []; // collidable AABBs
    const trees = []; // {x, y, r} — trunk collides, canopy hides people
    const decor = []; // purely visual
    const spots = []; // hiding spots: walk in and nobody can see you
    const zones = []; // special blocks
    const nodes = []; // NPC walking graph

    const addNode = (x, y, sx, sy, hot) => {
      nodes.push({ x, y, sx, sy, hot: !!hot, links: [] });
      return nodes.length - 1;
    };
    const link = (a, b) => {
      nodes[a].links.push(b);
      nodes[b].links.push(a);
    };

    const nx = RX.length, ny = RY.length;
    const inter = [];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) inter[j * nx + i] = addNode(RX[i], RY[j], 24, 24);
    const hMid = []; // hMid[j][i]: road at RY[j], between RX[i] and RX[i+1]
    for (let j = 0; j < ny; j++) {
      hMid[j] = [];
      for (let i = 0; i < nx - 1; i++) {
        const n = addNode((RX[i] + RX[i + 1]) / 2, RY[j], 60, 26);
        link(inter[j * nx + i], n);
        link(n, inter[j * nx + i + 1]);
        hMid[j][i] = n;
      }
    }
    const vMid = []; // vMid[j][i]: road at RX[i], between RY[j] and RY[j+1]
    for (let j = 0; j < ny - 1; j++) {
      vMid[j] = [];
      for (let i = 0; i < nx; i++) {
        const n = addNode(RX[i], (RY[j] + RY[j + 1]) / 2, 26, 60);
        link(inter[j * nx + i], n);
        link(n, inter[(j + 1) * nx + i]);
        vMid[j][i] = n;
      }
    }

    const tree = (x, y, r) => {
      trees.push({ x, y, r });
      obstacles.push({ x: x - 7, y: y - 7, w: 14, h: 14, kind: 'trunk' });
    };

    for (let bj = 0; bj < ny - 1; bj++) {
      for (let bi = 0; bi < nx - 1; bi++) {
        const x0 = RX[bi] + RH, y0 = RY[bj] + RH;
        const w = RX[bi + 1] - RX[bi] - 2 * RH, h = RY[bj + 1] - RY[bj] - 2 * RH;
        const cx = x0 + w / 2, cy = y0 + h / 2;
        const kind = SPECIALS[bi + ',' + bj];
        if (kind) {
          zones.push({ x: x0, y: y0, w, h, kind, name: ZONE_NAMES[kind] });
          let sx = 30, sy = 70, sides = 'tb';
          if (kind === 'taxi') {
            sx = 24; sy = 80;
            const xs = [x0 + 16, x0 + 60, x0 + 180, x0 + 224];
            const ys = [y0 + 28, y0 + 140];
            for (const bx of xs) for (const by of ys) {
              obstacles.push({ x: bx, y: by, w: 36, h: 76, kind: 'bus', color: AWNINGS[Math.floor(rnd() * AWNINGS.length)] });
            }
            decor.push({ kind: 'shelter', x: x0 + 100, y: y0 + 4, w: 76, h: 14 });
          } else if (kind === 'market') {
            sx = 14; sy = 90;
            const xs = [x0 + 14, x0 + 66, x0 + 166, x0 + 218];
            const ys = [y0 + 18, y0 + 80, y0 + 150, y0 + 206];
            for (const bx of xs) for (const by of ys) {
              obstacles.push({ x: bx, y: by, w: 44, h: 30, kind: 'stall', color: AWNINGS[Math.floor(rnd() * AWNINGS.length)] });
            }
          } else if (kind === 'pitch') {
            sx = 100; sy = 85; sides = 'tblr';
            decor.push({ kind: 'pitch', x: x0 + 14, y: y0 + 14, w: w - 28, h: h - 28 });
          } else if (kind === 'park') {
            sx = 60; sy = 60; sides = 'tblr';
            decor.push({ kind: 'grass', x: x0, y: y0, w, h });
            tree(x0 + 34, y0 + 34, 30);
            tree(x0 + w - 34, y0 + 34, 28);
            tree(x0 + 34, y0 + h - 34, 28);
            tree(x0 + w - 34, y0 + h - 34, 32);
            tree(cx - 70, cy + 10, 24);
            tree(cx + 74, cy - 14, 24);
            decor.push({ kind: 'bench', x: cx - 20, y: cy - 60, w: 40, h: 8 });
            decor.push({ kind: 'bench', x: cx - 20, y: cy + 56, w: 40, h: 8 });
            spots.push({ kind: 'mielies', x: x0 + 8, y: cy - 30, w: 50, h: 60 });
            spots.push({ kind: 'mielies', x: x0 + w - 58, y: cy - 30, w: 50, h: 60 });
          } else if (kind === 'spaza' || kind === 'shebeen') {
            sx = 30; sy = 70;
            const isSpaza = kind === 'spaza';
            obstacles.push({ x: x0 + 10, y: y0 + 26, w: 78, h: 112, kind: 'building', color: isSpaza ? '#c94f3d' : '#355c7d', label: isSpaza ? 'SPAZA' : 'SHEBEEN' });
            obstacles.push({ x: x0 + 188, y: y0 + 96, w: 78, h: 120, kind: 'building', color: isSpaza ? '#2f7d6d' : '#7d3a5c', label: isSpaza ? 'AIRTIME' : 'TAVERN' });
            decor.push({ kind: 'drum', x: x0 + 120, y: y0 + h - 30 });
            decor.push({ kind: 'crate', x: x0 + 96, y: y0 + 150 });
            spots.push({ kind: 'laundry', x: x0 + 104, y: y0 + 60, w: 68, h: 28 });
            spots.push({ kind: 'skip', x: x0 + 14, y: y0 + h - 44, w: 46, h: 30 });
            tree(x0 + 230, y0 + 44, 26);
          }
          const hot = addNode(cx, cy, sx, sy, true);
          const adj = [];
          if (sides.includes('t')) adj.push(hMid[bj][bi]);
          if (sides.includes('b')) adj.push(hMid[bj + 1][bi]);
          if (sides.includes('l')) adj.push(vMid[bj][bi]);
          if (sides.includes('r')) adj.push(vMid[bj][bi + 1]);
          for (const a of adj) {
            link(hot, a);
            // keep NPCs heading in/out of a block lined up with the lane
            if (sides === 'tb') nodes[a].sx = Math.min(nodes[a].sx, sx);
          }
        } else {
          // Residential block: shacks with alleys between them.
          const cols = rnd() < 0.5 ? 2 : 3, rows = 2;
          const cw = w / cols, ch = h / rows, m = 14;
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              const cellX = x0 + c * cw, cellY = y0 + r * ch;
              const roll = rnd();
              if (roll < 0.12) {
                tree(cellX + cw / 2, cellY + ch / 2, 24 + rnd() * 8);
                continue;
              }
              if (roll < 0.26) {
                const kinds = [['mielies', 58, 48], ['skip', 46, 30], ['laundry', 62, 28]];
                const [kind, sw, sh] = kinds[Math.floor(rnd() * kinds.length)];
                spots.push({ kind, x: Math.round(cellX + cw / 2 - sw / 2), y: Math.round(cellY + ch / 2 - sh / 2), w: sw, h: sh });
                continue;
              }
              const sw = Math.round(cw - 2 * m - rnd() * cw * 0.22);
              const sh = Math.round(ch - 2 * m - rnd() * ch * 0.28);
              const sxp = Math.round(cellX + m + rnd() * (cw - 2 * m - sw));
              const syp = Math.round(cellY + m + rnd() * (ch - 2 * m - sh));
              obstacles.push({
                x: sxp, y: syp, w: sw, h: sh, kind: 'shack',
                color: ROOFS[Math.floor(rnd() * ROOFS.length)],
                ridge: sw > sh ? 'v' : 'h',
                rust: rnd() < 0.45 ? { u: rnd(), v: rnd(), s: 0.2 + rnd() * 0.3 } : null,
                tire: rnd() < 0.3,
              });
              if (roll > 0.85) decor.push({ kind: 'tank', x: sxp + sw + 4, y: syp + 6 });
            }
          }
          if (rnd() < 0.5) {
            const ly = y0 + h / 2;
            decor.push({ kind: 'washing', x1: x0 + 10, y1: ly + (rnd() - 0.5) * 6, x2: x0 + w - 10, y2: ly + (rnd() - 0.5) * 6, seed: Math.floor(rnd() * 1e6) });
          }
        }
      }
    }

    // Skips on the road verges. Civilians wander through these too, so a
    // full skip isn't always a player.
    for (let k = 0; k < 14; k++) {
      const j = Math.floor(rnd() * ny), i = Math.floor(rnd() * (nx - 1));
      const x = RX[i] + 70 + rnd() * (RX[i + 1] - RX[i] - 140);
      const side = rnd() < 0.5 ? -1 : 1;
      spots.push({ kind: 'skip', x: Math.round(x - 23), y: Math.round(RY[j] + side * (RH - 15) - 14), w: 46, h: 28 });
    }

    // Potholes and litter on the roads, just for flavour.
    for (let k = 0; k < 60; k++) {
      const horiz = rnd() < 0.5;
      const x = horiz ? 60 + rnd() * (C.W - 120) : RX[Math.floor(rnd() * nx)] + (rnd() - 0.5) * 60;
      const y = horiz ? RY[Math.floor(rnd() * ny)] + (rnd() - 0.5) * 60 : 60 + rnd() * (C.H - 120);
      decor.push({ kind: rnd() < 0.6 ? 'pothole' : 'litter', x, y, r: 4 + rnd() * 7, a: rnd() * 6.28 });
    }

    const spawnNodes = nodes.map((n, i) => i).filter((i) => !nodes[i].hot);
    return { seed, obstacles, trees, decor, zones, nodes, spawnNodes, spots };
  };

  // ---- physics ---------------------------------------------------------
  function pushOut(p, r, o) {
    const cx = Math.max(o.x, Math.min(p.x, o.x + o.w));
    const cy = Math.max(o.y, Math.min(p.y, o.y + o.h));
    let dx = p.x - cx, dy = p.y - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 >= r * r) return;
    if (d2 > 1e-6) {
      const d = Math.sqrt(d2);
      p.x = cx + (dx / d) * r;
      p.y = cy + (dy / d) * r;
    } else {
      // centre is inside the box: leave by the shortest side
      const l = p.x - o.x, rr = o.x + o.w - p.x, t = p.y - o.y, b = o.y + o.h - p.y;
      const mn = Math.min(l, rr, t, b);
      if (mn === l) p.x = o.x - r;
      else if (mn === rr) p.x = o.x + o.w + r;
      else if (mn === t) p.y = o.y - r;
      else p.y = o.y + o.h + r;
    }
  }

  TFL.resolve = function (map, p, r) {
    for (let pass = 0; pass < 2; pass++) {
      for (const o of map.obstacles) {
        if (p.x + r < o.x || p.x - r > o.x + o.w || p.y + r < o.y || p.y - r > o.y + o.h) continue;
        pushOut(p, r, o);
      }
    }
    p.x = Math.max(r, Math.min(C.W - r, p.x));
    p.y = Math.max(r, Math.min(C.H - r, p.y));
    return p;
  };

  TFL.moveCircle = function (map, p, dx, dy, r) {
    // sub-step so a sprint can never tunnel through a thin wall
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (r * 0.8)));
    for (let s = 0; s < steps; s++) {
      p.x += dx / steps;
      p.y += dy / steps;
      TFL.resolve(map, p, r);
    }
    return p;
  };

  TFL.underTree = function (map, x, y) {
    for (const t of map.trees) if (Math.hypot(t.x - x, t.y - y) < C.TREE_COVER) return true;
    return false;
  };

  /** Index of the hiding spot containing (x, y), or -1. */
  TFL.spotAt = function (map, x, y) {
    for (let i = 0; i < map.spots.length; i++) {
      const s = map.spots[i];
      if (x > s.x && x < s.x + s.w && y > s.y && y < s.y + s.h) return i;
    }
    return -1;
  };

  /** Distance from a point to the edge of a spot (0 if inside). */
  TFL.spotDist = function (s, x, y) {
    const cx = Math.max(s.x, Math.min(x, s.x + s.w)), cy = Math.max(s.y, Math.min(y, s.y + s.h));
    return Math.hypot(x - cx, y - cy);
  };

  TFL.makeTicker = function (ms, fn) {
    // A worker-driven tick keeps the host simulating even if its tab is in
    // the background (plain setInterval gets throttled to ~1Hz there).
    try {
      const blob = new Blob(['setInterval(function(){postMessage(0)},' + ms + ')'], { type: 'text/javascript' });
      const url = URL.createObjectURL(blob);
      const w = new Worker(url);
      let fallback = null;
      w.onmessage = fn;
      w.onerror = () => {
        w.terminate();
        if (!fallback) fallback = setInterval(fn, ms);
      };
      return { stop() { w.terminate(); URL.revokeObjectURL(url); if (fallback) clearInterval(fallback); } };
    } catch (e) {
      const id = setInterval(fn, ms);
      return { stop() { clearInterval(id); } };
    }
  };

  TFL.esc = function (s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  };
})();
