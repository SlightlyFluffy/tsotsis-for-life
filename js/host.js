/* Tsotsi's For Life — host simulation.
 * One peer (whoever created the room) runs this. It owns the crowd, the
 * contracts and the scoring, and sends each player a personalised snapshot
 * that never says which bodies in the crowd are real players. */
(function () {
  'use strict';
  const TFL = window.TFL;
  const C = TFL.C;

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  class HostGame {
    /**
     * @param {object} o
     * @param {{pid:string,name:string,style:number}[]} o.players
     * @param {number} o.seed
     * @param {number} o.duration seconds
     * @param {(pid:string, msg:object)=>void} o.send
     * @param {(results:object[])=>void} o.onEnd
     */
    constructor(o) {
      this.map = TFL.buildMap(o.seed);
      this.send = o.send;
      this.onEnd = o.onEnd;
      this.timeLeft = o.duration;
      this.over = false;
      this.usedIds = new Set();
      this.players = new Map();
      this.npcs = [];

      const styles = o.players.map((p) => p.style);
      for (const p of o.players) {
        const sp = this.spawnPoint();
        this.players.set(p.pid, {
          pid: p.pid,
          name: p.name,
          style: p.style,
          id: this.newId(),
          x: sp.x,
          y: sp.y,
          tp: 1,
          state: 'alive',
          respawn: 0,
          target: null,
          contractT: 2 + Math.random() * 2,
          cooldown: 0,
          stun: 0,
          sinceSprint: 10,
          sprinting: false,
          moving: false,
          hidden: false,
          exposed: 0,
          unseen: true,
          score: 0,
          kills: 0,
          deaths: 0,
          stuns: 0,
          lastIn: 0,
          pending: [],
        });
      }
      // First contracts form one loop (A→B→C→A) so nobody starts with two
      // hunters while someone else has none.
      const order = [...this.players.values()].sort(() => Math.random() - 0.5);
      order.forEach((p, i) => { p.next = order[(i + 1) % order.length].pid; p.contractT = 3; });

      // The crowd: an even spread of every look that is in play.
      const count = C.NPC_PER_STYLE * styles.length;
      for (let i = 0; i < count; i++) this.npcs.push(this.makeNpc(styles[i % styles.length]));
    }

    newId() {
      let id;
      do id = 1 + Math.floor(Math.random() * 60000);
      while (this.usedIds.has(id));
      this.usedIds.add(id);
      return id;
    }

    nodePoint(n) {
      return { x: n.x + rand(-n.sx, n.sx), y: n.y + rand(-n.sy, n.sy) };
    }

    makeNpc(style) {
      const nodes = this.map.nodes;
      const start = Math.floor(Math.random() * nodes.length);
      const p = this.nodePoint(nodes[start]);
      const n = { id: this.newId(), style, x: p.x, y: p.y, node: start, prev: -1, tx: p.x, ty: p.y, speed: rand(C.NPC_MIN, C.NPC_MAX), idle: 0, down: 0 };
      this.arrive(n);
      if (nodes[start].hot) n.idle = rand(0, 12);
      return n;
    }

    arrive(n) {
      const nodes = this.map.nodes;
      const here = nodes[n.node];
      if (here.hot) n.idle = rand(5, 16);
      else if (Math.random() < 0.08) n.idle = rand(1.5, 5);
      let options = here.links.filter((l) => l !== n.prev);
      if (!options.length) options = here.links;
      // Hot spots (rank, market, pitch...) pull people in, but not every time.
      const cold = options.filter((l) => !nodes[l].hot);
      const hot = options.filter((l) => nodes[l].hot);
      const next = hot.length && (Math.random() < 0.4 || !cold.length) ? pick(hot) : pick(cold.length ? cold : options);
      n.prev = n.node;
      n.node = next;
      const p = this.nodePoint(nodes[next]);
      n.tx = p.x;
      n.ty = p.y;
    }

    spawnPoint() {
      const nodes = this.map.nodes;
      const alive = [...(this.players ? this.players.values() : [])].filter((p) => p.state === 'alive');
      let best = null, bestD = -1;
      for (let k = 0; k < 24; k++) {
        const n = nodes[pick(this.map.spawnNodes)];
        const p = this.nodePoint(n);
        let d = 1e9;
        for (const o of alive) d = Math.min(d, dist(o, p));
        if (d > 450) return p;
        if (d > bestD) { bestD = d; best = p; }
      }
      return best;
    }

    // ---- input -----------------------------------------------------------
    handle(pid, msg) {
      const p = this.players.get(pid);
      if (!p || this.over) return;
      if (msg.t === 'in') {
        p.pending.push(msg);
        if (p.pending.length > 8) p.pending.shift();
      } else if (msg.t === 'act') {
        p.wantsAct = true;
      }
    }

    applyInput(p, dt) {
      const now = performance.now();
      const msgs = p.pending;
      p.pending = [];
      if (!msgs.length) {
        if (now - p.lastIn > 300) { p.moving = false; p.sprinting = false; }
        return;
      }
      const m = msgs[msgs.length - 1];
      const elapsed = Math.min(0.5, p.lastIn ? (now - p.lastIn) / 1000 : dt);
      p.lastIn = now;
      if (m.tp !== p.tp || p.state !== 'alive' || p.stun > 0) return; // stale or frozen
      if (!isFinite(m.x) || !isFinite(m.y)) return;
      // Movement is client-predicted for responsiveness; the host only allows
      // what a sprinting body could have covered.
      const maxD = C.SPRINT * elapsed * 1.4 + 6;
      let dx = m.x - p.x, dy = m.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d > maxD) { dx *= maxD / d; dy *= maxD / d; }
      const np = { x: p.x + dx, y: p.y + dy };
      TFL.resolve(this.map, np, C.R);
      p.moving = !!m.mv && d > 0.5;
      p.sprinting = !!m.sp && p.moving;
      p.x = np.x;
      p.y = np.y;
    }

    // ---- simulation ------------------------------------------------------
    tick(dt) {
      if (this.over) return;
      this.timeLeft -= dt;
      for (const n of this.npcs) this.updateNpc(n, dt);

      const players = [...this.players.values()];
      for (const p of players) {
        p.cooldown = Math.max(0, p.cooldown - dt);
        p.stun = Math.max(0, p.stun - dt);
        p.exposed = Math.max(0, p.exposed - dt);
        if (p.state === 'dead') {
          p.respawn -= dt;
          if (p.respawn <= 0) {
            const sp = this.spawnPoint();
            p.x = sp.x; p.y = sp.y; p.tp++;
            p.state = 'alive';
            p.pending = [];
          }
          continue;
        }
        this.applyInput(p, dt);
        p.sinceSprint = p.sprinting ? 0 : p.sinceSprint + dt;
        let near = 0;
        for (const n of this.npcs) {
          if (n.down <= 0 && Math.abs(n.x - p.x) < C.BLEND_RADIUS && Math.abs(n.y - p.y) < C.BLEND_RADIUS && dist(n, p) < C.BLEND_RADIUS) near++;
        }
        p.hidden = !p.sprinting && (near >= C.BLEND_COUNT || TFL.underTree(this.map, p.x, p.y));
      }

      for (const p of players) {
        if (p.state !== 'alive') continue;
        const t = p.target && this.players.get(p.target);
        if (t && p.sprinting && dist(p, t) < C.EXPOSE_RANGE) {
          if (p.exposed <= 0) this.event(t.pid, { pop: { title: 'HUNTER SPOTTED', lines: ['Someone sprinted at you — they are marked red.'], color: '#e74c3c' }, sfx: 'alarm' });
          p.exposed = C.EXPOSE_TIME;
          p.unseen = false;
        }
        if (!p.target) {
          p.contractT -= dt;
          if (p.contractT <= 0) this.assign(p);
        }
      }

      for (const p of players) {
        if (p.wantsAct) { p.wantsAct = false; this.action(p); }
      }

      if (this.timeLeft <= 0) return this.finish();
      this.broadcast();
    }

    updateNpc(n, dt) {
      if (n.down > 0) { n.down -= dt; return; }
      if (n.idle > 0) { n.idle -= dt; return; }
      const dx = n.tx - n.x, dy = n.ty - n.y;
      const d = Math.hypot(dx, dy);
      const step = n.speed * dt;
      if (d <= step) { n.x = n.tx; n.y = n.ty; this.arrive(n); }
      else { n.x += (dx / d) * step; n.y += (dy / d) * step; }
    }

    hunterCount(pid) {
      let c = 0;
      for (const p of this.players.values()) if (p.target === pid) c++;
      return c;
    }

    assign(p) {
      const cands = [...this.players.values()].filter((o) => o.pid !== p.pid && o.state === 'alive' && this.hunterCount(o.pid) < C.MAX_HUNTERS);
      if (!cands.length) { p.contractT = 1; return; }
      let t = cands.find((c) => c.pid === p.next);
      p.next = null;
      if (!t) {
        // Prefer people with the fewest hunters; mildly avoid mutual contracts
        // and handing you straight back to whoever just took you out.
        const cost = (c) => this.hunterCount(c.pid) + (c.target === p.pid ? 0.3 : 0) + (c.pid === p.lastKiller ? 0.5 : 0);
        let min = Infinity;
        for (const c of cands) min = Math.min(min, cost(c));
        t = pick(cands.filter((c) => cost(c) === min));
      }
      p.target = t.pid;
      p.unseen = true;
      this.event(p.pid, { pop: { title: 'NEW CONTRACT', lines: [t.name + ' — wearing the ' + TFL.STYLES[t.style].name], color: '#f1c40f' }, sfx: 'contract' });
    }

    nearestEntity(p) {
      let best = null, bestD = C.ACTION_RANGE;
      for (const n of this.npcs) {
        if (n.down > 0) continue;
        const d = dist(n, p);
        if (d < bestD) { bestD = d; best = { npc: n }; }
      }
      for (const o of this.players.values()) {
        if (o === p || o.state !== 'alive') continue;
        const d = dist(o, p);
        // players get a tiny priority so a target standing in a crowd is
        // not "stolen" by a civilian at the same distance
        if (d - 2 < bestD) { bestD = d - 2; best = { player: o }; }
      }
      return best;
    }

    action(a) {
      if (a.state !== 'alive' || a.stun > 0 || a.cooldown > 0) return;
      a.cooldown = 0.35;
      const hit = this.nearestEntity(a);
      if (!hit) return;
      const o = hit.player;

      if (o && a.target === o.pid) return this.takeOut(a, o);

      if (o && o.target === a.pid) {
        // Caught your hunter before they got you.
        o.stun = C.STUN_TIME;
        o.target = null;
        o.contractT = C.STUN_TIME + C.NEW_CONTRACT;
        o.exposed = 0;
        a.score += C.SCORE.STUN;
        a.stuns++;
        this.event(a.pid, { pop: { title: 'HUNTER KLAPPED', lines: ['Stunned ' + o.name + '  +' + C.SCORE.STUN], color: '#2ecc71' }, sfx: 'stun' });
        this.event(o.pid, { pop: { title: 'YOU GOT KLAPPED', lines: [a.name + ' saw you coming. Contract lost.'], color: '#e74c3c' }, sfx: 'bad' });
        this.feed(a.name + ' klapped ' + o.name + ' (+' + C.SCORE.STUN + ')');
        return;
      }

      // Wrong person — civilian or an uninvolved player.
      if (hit.npc) hit.npc.down = C.NPC_DOWN;
      else { o.stun = Math.max(o.stun, C.BUMP_STUN); this.event(o.pid, { pop: { title: 'BUMPED', lines: ['Someone shoved you by mistake.'], color: '#e67e22' } }); }
      const hadContract = !!a.target;
      a.target = null;
      a.contractT = C.WHIFF_CONTRACT;
      a.cooldown = C.WHIFF_COOLDOWN;
      this.event(a.pid, { pop: { title: 'WRONG PERSON', lines: [hadContract ? 'Contract lost. Lie low for a bit.' : 'That was a civilian. Lie low.'], color: '#e67e22' }, sfx: 'bad' });
    }

    takeOut(a, t) {
      const bonus = [['Take-out', C.SCORE.KILL]];
      if (a.sinceSprint > 2) bonus.push(['Low profile', C.SCORE.LOW_PROFILE]);
      if (a.hidden) bonus.push(['Blended in', C.SCORE.BLENDED]);
      if (a.unseen) bonus.push(['Never spotted', C.SCORE.UNSEEN]);
      const pts = bonus.reduce((s, b) => s + b[1], 0);
      a.score += pts;
      a.kills++;
      a.target = null;
      a.contractT = C.NEW_CONTRACT;

      t.state = 'dead';
      t.respawn = C.RESPAWN;
      t.deaths++;
      t.target = null;
      t.contractT = 1.5;
      t.stun = 0;
      t.exposed = 0;
      t.lastKiller = a.pid;

      for (const h of this.players.values()) {
        if (h !== a && h.target === t.pid) {
          h.target = null;
          h.contractT = C.NEW_CONTRACT;
          this.event(h.pid, { pop: { title: 'CONTRACT GONE', lines: ['Another tsotsi got to ' + t.name + ' first.'], color: '#95a5a6' } });
        }
      }
      this.event(a.pid, { pop: { title: 'TAKEN OUT  +' + pts, lines: bonus.map((b) => b[0] + '  +' + b[1]), color: '#f1c40f' }, sfx: 'kill' });
      this.event(t.pid, { pop: { title: 'TAKEN OUT', lines: ['by ' + a.name + ' (' + TFL.STYLES[a.style].name + ')'], color: '#e74c3c' }, sfx: 'dead' });
      this.feed(a.name + ' took out ' + t.name + ' (+' + pts + ')');
    }

    removePlayer(pid) {
      const p = this.players.get(pid);
      if (!p) return;
      this.players.delete(pid);
      for (const o of this.players.values()) {
        if (o.target === pid) { o.target = null; o.contractT = C.NEW_CONTRACT; }
      }
      this.feed(p.name + ' left the kasi');
      if (!this.over && this.players.size < 2) this.finish();
    }

    // ---- output ----------------------------------------------------------
    event(pid, ev) {
      this.send(pid, Object.assign({ t: 'ev' }, ev));
    }

    feed(text) {
      for (const pid of this.players.keys()) this.send(pid, { t: 'ev', feed: text });
    }

    scoreboard() {
      return [...this.players.values()]
        .sort((a, b) => b.score - a.score)
        .map((p) => ({ name: p.name, style: p.style, score: p.score, kills: p.kills, deaths: p.deaths, stuns: p.stuns }));
    }

    broadcast() {
      const ents = [];
      for (const n of this.npcs) ents.push([n.id, Math.round(n.x), Math.round(n.y), n.style, n.down > 0 ? 1 : 0]);
      const players = [...this.players.values()];
      for (const p of players) ents.push([p.id, Math.round(p.x), Math.round(p.y), p.style, (p.state === 'dead' ? 1 : 0) | (p.stun > 0 ? 2 : 0) | (p.sprinting ? 4 : 0)]);
      // Sort by id so a player's position in the list gives nothing away.
      ents.sort((a, b) => a[0] - b[0]);
      const sb = this.scoreboard().map((s) => [s.name, s.score, s.style]);
      const tl = Math.max(0, Math.ceil(this.timeLeft));

      for (const p of players) {
        const me = {
          id: p.id, tp: p.tp, x: Math.round(p.x), y: Math.round(p.y),
          st: p.state === 'dead' ? 1 : p.stun > 0 ? 2 : 0,
          rs: Math.ceil(p.respawn), cd: +p.cooldown.toFixed(1), sc: p.score,
          bl: p.hidden ? 1 : 0, ex: p.exposed > 0 ? 1 : 0,
          tgt: null, ct: p.target ? 0 : Math.max(0, Math.ceil(p.contractT)),
          hn: 0, hb: 0, exp: [],
        };
        const t = p.target && this.players.get(p.target);
        if (t && p.state === 'alive') {
          const d = dist(p, t);
          const locked = t.state === 'alive' && d < (t.hidden ? C.LOCK_RANGE_HIDDEN : C.LOCK_RANGE);
          me.tgt = { s: t.style, n: t.name, a: +Math.atan2(t.y - p.y, t.x - p.x).toFixed(2), b: locked ? 3 : d < 320 ? 2 : d < 650 ? 1 : 0 };
          if (locked) me.tgt.id = t.id;
        }
        let nearest = Infinity;
        for (const h of players) {
          if (h.target !== p.pid || h.state !== 'alive') continue;
          me.hn++;
          nearest = Math.min(nearest, dist(h, p));
          if (h.exposed > 0) me.exp.push(h.id);
        }
        me.hb = nearest < 150 ? 3 : nearest < 300 ? 2 : nearest < 500 ? 1 : 0;
        this.send(p.pid, { t: 's', tl, e: ents, me, sb });
      }
    }

    finish() {
      if (this.over) return;
      this.over = true;
      this.onEnd(this.scoreboard());
    }
  }

  TFL.HostGame = HostGame;
})();
