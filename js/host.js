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
     * @param {{pid:string,name:string,style:number,bot?:boolean}[]} o.players
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
          pid: p.pid, name: p.name, style: p.style, bot: !!p.bot, id: this.newId(),
          x: sp.x, y: sp.y, tp: 1,
          state: 'alive', respawn: 0,
          target: null, contractT: 3, next: null,
          cooldown: 0, stun: 0, lock: 0,
          sinceSprint: 10, sprinting: false, moving: false,
          hidden: false, spot: -1, exposed: 0, unseen: true, revealed: 0, idProg: 0,
          cds: { dust: 0, poison: 0, clone: 0, decoy: 0 },
          poisonT: 0, poisoner: null,
          score: 0, kills: 0, deaths: 0, stuns: 0,
          lastIn: 0, pending: [], wants: [],
        });
      }
      // First contracts form one loop (A→B→C→A) so nobody starts with two
      // hunters while someone else has none.
      const order = [...this.players.values()].sort(() => Math.random() - 0.5);
      order.forEach((p, i) => { p.next = order[(i + 1) % order.length].pid; });

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

    // ---- the crowd -------------------------------------------------------
    makeNpc(style) {
      const nodes = this.map.nodes;
      const start = Math.floor(Math.random() * nodes.length);
      const p = this.nodePoint(nodes[start]);
      const n = {
        id: this.newId(), style, x: p.x, y: p.y, node: start, prev: -1, tx: p.x, ty: p.y,
        speed: rand(C.NPC_MIN, C.NPC_MAX), idle: 0, down: 0, hurry: false,
        quirkT: rand(2, 14), follow: null, followT: 0,
        cloneStyle: -1, cloneT: 0, decoyT: 0, decoyFrom: null, poisonT: 0,
      };
      this.arrive(n);
      if (nodes[start].hot) n.idle = rand(0, 12);
      return n;
    }

    arrive(n) {
      const nodes = this.map.nodes;
      const here = nodes[n.node];
      let options = here.links.filter((l) => l !== n.prev);
      if (!options.length) options = here.links;
      let next;
      if (n.decoyT > 0) {
        // a decoy keeps running away from whoever set it off
        next = options.reduce((b, l) => (dist(nodes[l], n.decoyFrom) > dist(nodes[b], n.decoyFrom) ? l : b), options[0]);
      } else {
        if (here.hot) n.idle = rand(5, 16);
        else if (Math.random() < 0.08) n.idle = rand(1.5, 5);
        // Hot spots (rank, market, pitch...) pull people in, but not every time.
        const cold = options.filter((l) => !nodes[l].hot);
        const hot = options.filter((l) => nodes[l].hot);
        next = hot.length && (Math.random() < 0.4 || !cold.length) ? pick(hot) : pick(cold.length ? cold : options);
        // Now and then a civilian is in a hurry, so a fast mover isn't
        // automatically a player.
        n.hurry = Math.random() < 0.07;
      }
      n.prev = n.node;
      n.node = next;
      const p = this.nodePoint(nodes[next]);
      n.tx = p.x;
      n.ty = p.y;
    }

    /** Random civilian behaviour, to keep everyone guessing. */
    quirk(n) {
      n.quirkT = rand(4, 16);
      if (n.decoyT > 0 || n.idle > 0) return;
      const r = Math.random();
      if (r < 0.28) {
        // forgot something — turn back
        const t = n.node; n.node = n.prev >= 0 ? n.prev : n.node; n.prev = t;
        const p = this.nodePoint(this.map.nodes[n.node]); n.tx = p.x; n.ty = p.y;
      } else if (r < 0.5) {
        n.idle = rand(1, 3.5); // stops dead, looks around
      } else if (r < 0.68) {
        n.hurry = true; // breaks into a jog
      } else if (r < 0.85) {
        // tails somebody for a bit — maybe you
        let best = null, bd = 220;
        for (const p of this.players.values()) {
          if (p.state !== 'alive') continue;
          const d = dist(p, n);
          if (d < bd && Math.random() < 0.7) { bd = d; best = p; }
        }
        if (!best) for (const o of this.npcs) if (o !== n && dist(o, n) < 160) { best = o; break; }
        if (best) { n.follow = best; n.followT = rand(4, 8); }
      } else {
        // sidestep
        n.tx += rand(-40, 40); n.ty += rand(-40, 40);
      }
    }

    updateNpc(n, dt) {
      if (n.cloneT > 0 && (n.cloneT -= dt) <= 0) n.cloneStyle = -1;
      if (n.poisonT > 0 && (n.poisonT -= dt) <= 0) n.down = C.NPC_DOWN * 2;
      if (n.down > 0) { n.down -= dt; return; }
      if (n.decoyT > 0) {
        n.decoyT -= dt;
        if (n.decoyT <= 0) n.cloneStyle = n.cloneT > 0 ? n.cloneStyle : -1;
      }
      if ((n.quirkT -= dt) <= 0) this.quirk(n);
      if (n.idle > 0) { n.idle -= dt; return; }
      if (n.follow) {
        n.followT -= dt;
        const f = n.follow;
        if (n.followT <= 0 || (f.state && f.state !== 'alive')) { n.follow = null; }
        else {
          const d = dist(n, f);
          if (d > 30) { const s = Math.min(d - 30, n.speed * dt); n.x += ((f.x - n.x) / d) * s; n.y += ((f.y - n.y) / d) * s; }
          return;
        }
      }
      const dx = n.tx - n.x, dy = n.ty - n.y;
      const d = Math.hypot(dx, dy);
      const step = (n.decoyT > 0 ? C.SPRINT : n.hurry ? 150 : n.speed) * dt;
      if (d <= step) { n.x = n.tx; n.y = n.ty; this.arrive(n); }
      else { n.x += (dx / d) * step; n.y += (dy / d) * step; }
    }

    spawnPoint() {
      const nodes = this.map.nodes;
      const alive = [...this.players.values()].filter((p) => p.state === 'alive');
      let best = null, bestD = -1;
      for (let k = 0; k < 24; k++) {
        const p = this.nodePoint(nodes[pick(this.map.spawnNodes)]);
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
        const kind = msg.kind === 'poison' ? 'poison' : 'strike';
        if (Number.isInteger(msg.id)) p.wants.push({ kind, id: msg.id });
        else if (Number.isInteger(msg.spot) && this.map.spots[msg.spot]) p.wants.push({ kind, spot: msg.spot });
      } else if (msg.t === 'ab' && ['dust', 'clone', 'decoy'].includes(msg.k)) {
        p.wants.push({ kind: msg.k });
      }
      if (p.wants.length > 4) p.wants.shift();
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
      if (m.tp !== p.tp || p.state !== 'alive' || p.stun > 0 || p.lock > 0) return; // stale or frozen
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

    // ---- bots ------------------------------------------------------------
    nearestNode(p) {
      let best = 0, bd = Infinity;
      this.map.nodes.forEach((n, i) => { const d = dist(n, p); if (d < bd) { bd = d; best = i; } });
      return best;
    }

    botThink(p, dt) {
      p.moving = false;
      p.sprinting = false;
      if (p.stun > 0 || p.lock > 0) return;
      const nodes = this.map.nodes;
      const t = p.target && this.players.get(p.target);
      const reached = p.nav != null && Math.hypot(nodes[p.nav].x - p.x, nodes[p.nav].y - p.y) < 16;
      let gx, gy, sprint = false;
      p.botStuck = Math.max(0, (p.botStuck || 0) - dt);

      if (t && t.state === 'alive') {
        const d = dist(p, t);
        if (d < 220 && p.botStuck <= 0) {
          gx = t.x; gy = t.y;
          p.nav = null;
        } else {
          // greedy walk along the street graph towards the target
          if (p.nav == null) p.nav = this.nearestNode(p);
          else if (reached) {
            const links = nodes[p.nav].links;
            p.nav = links.reduce((b, l) => (dist(nodes[l], t) < dist(nodes[b], t) ? l : b), links[0]);
          }
          gx = nodes[p.nav].x; gy = nodes[p.nav].y;
          sprint = d > 520;
        }
        // strike — walking only, with a little human-ish hesitation
        if (d < C.ACTION_RANGE - 6 && p.sinceSprint >= C.CALM_TIME && p.cooldown <= 0 && Math.random() < 0.2) {
          const kind = p.cds.poison <= 0 && Math.random() < 0.35 ? 'poison' : 'strike';
          p.wants.push(t.spot >= 0 ? { kind, spot: t.spot } : { kind, id: t.id });
        }
      } else {
        // no contract: drift around like a civilian
        if (p.nav == null) p.nav = this.nearestNode(p);
        else if (reached) p.nav = pick(nodes[p.nav].links);
        gx = nodes[p.nav].x; gy = nodes[p.nav].y;
      }

      // defence: sometimes catches a hunter who gets too close, sometimes
      // throws them off with an ability
      for (const h of this.players.values()) {
        if (h.target !== p.pid || h.state !== 'alive') continue;
        const d = dist(h, p);
        if (d < C.ACTION_RANGE - 4 && p.cooldown <= 0 && Math.random() < (h.exposed > 0 ? 0.25 : 0.04)) p.wants.push({ kind: 'strike', id: h.id });
        if (d < 45 && p.cds.dust <= 0 && Math.random() < 0.01) p.wants.push({ kind: 'dust' });
        if (d < 200 && Math.random() < 0.004) p.wants.push({ kind: Math.random() < 0.5 ? 'clone' : 'decoy' });
      }

      const dx = gx - p.x, dy = gy - p.y, dd = Math.hypot(dx, dy);
      if (dd < 4) return;
      const sp = (sprint ? C.SPRINT : C.WALK) * dt;
      const before = { x: p.x, y: p.y };
      TFL.moveCircle(this.map, p, (dx / dd) * Math.min(sp, dd), (dy / dd) * Math.min(sp, dd), C.R);
      p.moving = true;
      p.sprinting = sprint;
      // stuck on a shack corner? fall back to the road graph for a bit
      if (Math.hypot(p.x - before.x, p.y - before.y) < sp * 0.3) { p.botStuck = 2; p.nav = null; }
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
        p.lock = Math.max(0, p.lock - dt);
        p.exposed = Math.max(0, p.exposed - dt);
        p.revealed = Math.max(0, p.revealed - dt);
        for (const k in p.cds) p.cds[k] = Math.max(0, p.cds[k] - dt);
        if (p.state === 'dead') {
          p.respawn -= dt;
          if (p.respawn <= 0) {
            const sp = this.spawnPoint();
            p.x = sp.x; p.y = sp.y; p.tp++; p.nav = null;
            p.state = 'alive';
            p.pending = [];
          }
          continue;
        }
        // poison works quietly, then all at once
        if (p.poisonT > 0 && (p.poisonT -= dt) <= 0) {
          const by = this.players.get(p.poisoner);
          this.die(p, by, by ? [['Poison', C.SCORE.POISON]] : [], 'poison');
          continue;
        }
        if (p.bot) this.botThink(p, dt);
        else this.applyInput(p, dt);
        p.sinceSprint = p.sprinting ? 0 : p.sinceSprint + dt;
        p.spot = TFL.spotAt(this.map, p.x, p.y);
        let near = 0;
        for (const n of this.npcs) {
          if (n.down <= 0 && Math.abs(n.x - p.x) < C.BLEND_RADIUS && Math.abs(n.y - p.y) < C.BLEND_RADIUS && dist(n, p) < C.BLEND_RADIUS) near++;
        }
        p.hidden = p.spot >= 0 || (!p.sprinting && (near >= C.BLEND_COUNT || TFL.underTree(this.map, p.x, p.y)));
      }

      for (const p of players) {
        if (p.state !== 'alive') continue;
        const t = p.target && this.players.get(p.target);
        if (t && p.sprinting && dist(p, t) < C.EXPOSE_RANGE) {
          if (p.exposed <= 0) this.event(t.pid, { pop: { title: 'HUNTER SPOTTED', lines: ['Someone sprinted at you — they are marked red.'], color: '#e74c3c' }, sfx: 'alarm' });
          p.exposed = C.EXPOSE_TIME;
          p.unseen = false;
        }
        if (t) {
          const d = dist(p, t);
          const seeing = t.state === 'alive' && !t.hidden && d < C.LOCK_RANGE;
          const keep = t.state === 'alive' && !t.hidden && d < C.LOCK_RANGE * 1.6 && p.idProg >= C.ID_TIME;
          if (seeing || keep) p.idProg = Math.min(C.ID_TIME, p.idProg + dt);
          else p.idProg = Math.max(0, p.idProg - dt * 0.75);
        }
        if (!p.target) {
          p.idProg = 0;
          p.contractT -= dt;
          if (p.contractT <= 0) this.assign(p);
        }
      }

      for (const p of players) {
        const wants = p.wants;
        p.wants = [];
        for (const w of wants) {
          if (w.kind === 'strike' || w.kind === 'poison') this.action(p, w);
          else this.ability(p, w.kind);
        }
      }

      if (this.timeLeft <= 0) return this.finish();
      this.broadcast();
    }

    hunterCount(pid) {
      let c = 0;
      for (const p of this.players.values()) if (p.target === pid) c++;
      return c;
    }

    assign(p) {
      const cands = [...this.players.values()].filter((o) => o.pid !== p.pid && o.state === 'alive' && o.poisonT <= 0 && this.hunterCount(o.pid) < C.MAX_HUNTERS);
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
      p.idProg = 0;
      this.event(p.pid, { pop: { title: 'NEW CONTRACT', lines: [t.name + ' — wearing the ' + TFL.STYLES[t.style].name], color: '#f1c40f' }, sfx: 'contract' });
    }

    // ---- strikes ---------------------------------------------------------
    /** Resolve what a strike lands on: a clicked body, or whoever is in a spot. */
    resolveHit(a, w) {
      if (w.spot !== undefined) {
        const s = this.map.spots[w.spot];
        if (TFL.spotDist(s, a.x, a.y) > C.ACTION_RANGE - 4) return { far: true };
        const inside = (e) => e.x > s.x && e.x < s.x + s.w && e.y > s.y && e.y < s.y + s.h;
        const ps = [...this.players.values()].filter((o) => o !== a && o.state === 'alive' && inside(o));
        // you find whoever is hiding there — your mark first, then your hunter
        const o = ps.find((o) => o.pid === a.target) || ps.find((o) => o.target === a.pid) || ps[0];
        if (o) return { player: o };
        const n = this.npcs.find((n) => n.down <= 0 && inside(n));
        if (n) return { npc: n };
        return { empty: true };
      }
      for (const n of this.npcs) if (n.id === w.id) return n.down > 0 ? null : dist(n, a) > C.ACTION_RANGE + 8 ? { far: true } : { npc: n };
      for (const o of this.players.values()) {
        if (o.id !== w.id) continue;
        if (o === a || o.state !== 'alive') return null;
        return dist(o, a) > C.ACTION_RANGE + 8 ? { far: true } : { player: o };
      }
      return null;
    }

    action(a, w) {
      if (a.state !== 'alive' || a.stun > 0 || a.lock > 0 || a.cooldown > 0) return;
      const poison = w.kind === 'poison';
      if (poison && a.cds.poison > 0) return;
      a.cooldown = 0.35;
      if (a.sinceSprint < C.CALM_TIME) {
        // Running at people and swinging doesn't work. Same reply whoever is
        // nearby, so it gives nothing away.
        a.cooldown = 0.8;
        this.event(a.pid, { pop: { title: 'TOO LOUD', lines: ['Stop running first — you can only strike while walking.'], color: '#e67e22' }, sfx: 'bad' });
        return;
      }
      const hit = this.resolveHit(a, w);
      if (!hit) return;
      if (hit.far) {
        a.cooldown = 0.2;
        this.event(a.pid, { pop: { title: 'OUT OF REACH', lines: ['Get right next to them first.'], color: '#95a5a6' } });
        return;
      }
      if (hit.empty) {
        a.cooldown = 1;
        this.event(a.pid, { pop: { title: 'NOBODY IN THERE', lines: ['Just rubbish and mielies.'], color: '#95a5a6' } });
        return;
      }
      const o = hit.player;

      if (poison) {
        a.cds.poison = C.POISON_CD;
        if (o && a.target === o.pid) {
          // Silent: the victim gets no warning at all.
          o.poisonT = C.POISON_TIME;
          o.poisoner = a.pid;
          a.target = null;
          a.idProg = 0;
          a.contractT = C.POISON_TIME + C.NEW_CONTRACT;
          this.event(a.pid, { pop: { title: 'POISONED', lines: [o.name + " drops in " + C.POISON_TIME + "s. Walk away."], color: '#7bd66b' }, sfx: 'stun' });
          return;
        }
        // Wrong person: same penalty, but poison is quiet — no scream.
        if (hit.npc) hit.npc.poisonT = C.POISON_TIME;
        return this.wrongPerson(a, false);
      }

      if (o && a.target === o.pid) return this.die(o, a, this.killBonus(a), 'strike');

      if (o && o.target === a.pid) {
        // Caught your hunter before they got you.
        o.stun = C.STUN_TIME;
        o.target = null;
        o.contractT = C.STUN_TIME + C.NEW_CONTRACT;
        o.exposed = 0;
        a.score += C.SCORE.STUN;
        a.stuns++;
        this.fx({ k: 'klap', x: Math.round(o.x), y: Math.round(o.y) });
        this.event(a.pid, { pop: { title: 'HUNTER KLAPPED  +' + C.SCORE.STUN, lines: ['Stunned ' + o.name], color: '#2ecc71' }, sfx: 'stun' });
        this.event(o.pid, { pop: { title: 'YOU GOT KLAPPED', lines: [a.name + ' saw you coming. Contract lost.'], color: '#e74c3c' }, sfx: 'bad' });
        this.feed(a.name + ' klapped ' + o.name + ' (+' + C.SCORE.STUN + ')');
        return;
      }

      // Wrong person — civilian or an uninvolved player.
      if (hit.npc) hit.npc.down = C.NPC_DOWN;
      else { o.stun = Math.max(o.stun, C.BUMP_STUN); this.event(o.pid, { pop: { title: 'BUMPED', lines: ['Someone shoved you by mistake.'], color: '#e67e22' } }); }
      this.wrongPerson(a, true);
    }

    wrongPerson(a, loud) {
      a.target = null;
      a.idProg = 0;
      a.contractT = C.WHIFF_CONTRACT;
      a.cooldown = C.WHIFF_COOLDOWN;
      a.score = Math.max(0, a.score - C.WHIFF_POINTS);
      const lines = ['Contract lost — no new one for ' + C.WHIFF_CONTRACT + 's.', "Can't strike for " + C.WHIFF_COOLDOWN + 's.'];
      if (loud) {
        // The scream gives you away to everyone hunting you.
        a.revealed = C.WHIFF_REVEAL;
        lines.push('The scream gave you away to your hunters!');
        for (const h of this.players.values()) {
          if (h.target === a.pid) this.event(h.pid, { pop: { title: 'SOMEONE SCREAMED', lines: [a.name + ' hit the wrong person — marked for ' + C.WHIFF_REVEAL + 's!'], color: '#f1c40f' }, sfx: 'alarm' });
        }
      }
      this.event(a.pid, { pop: { title: 'WRONG PERSON  −' + C.WHIFF_POINTS, lines, color: '#e74c3c' }, sfx: 'bad' });
    }

    killBonus(a) {
      const bonus = [['Take-out', C.SCORE.KILL]];
      if (a.sinceSprint > 2) bonus.push(['Low profile', C.SCORE.LOW_PROFILE]);
      if (a.hidden) bonus.push([a.spot >= 0 ? 'From hiding' : 'Blended in', C.SCORE.BLENDED]);
      if (a.unseen) bonus.push(['Never spotted', C.SCORE.UNSEEN]);
      return bonus;
    }

    /** A player goes down. `a` may be null (e.g. the poisoner left). */
    die(t, a, bonus, how) {
      const pts = bonus.reduce((s, b) => s + b[1], 0);
      if (a) {
        a.score += pts;
        a.kills++;
        if (a.target === t.pid) { a.target = null; a.contractT = C.NEW_CONTRACT; }
        if (how === 'strike') a.lock = C.KILL_LOCK;
      }
      this.fx({ k: how === 'poison' ? 'poison' : 'kill', x: Math.round(t.x), y: Math.round(t.y), fx: a ? Math.round(a.x) : t.x, fy: a ? Math.round(a.y) : t.y });

      t.state = 'dead';
      t.respawn = C.RESPAWN;
      t.deaths++;
      t.target = null;
      t.contractT = 1.5;
      t.stun = 0;
      t.lock = 0;
      t.exposed = 0;
      t.poisonT = 0;
      t.poisoner = null;
      if (a) t.lastKiller = a.pid;

      for (const h of this.players.values()) {
        if (h !== a && h.target === t.pid) {
          h.target = null;
          h.contractT = C.NEW_CONTRACT;
          this.event(h.pid, { pop: { title: 'CONTRACT GONE', lines: ['Another tsotsi got to ' + t.name + ' first.'], color: '#95a5a6' } });
        }
      }
      const verb = how === 'poison' ? 'poisoned' : 'took out';
      if (a) this.event(a.pid, { pop: { title: (how === 'poison' ? 'POISON WORKED' : 'TAKEN OUT') + '  +' + pts, lines: bonus.map((b) => b[0] + '  +' + b[1]), color: '#f1c40f' }, sfx: 'kill' });
      this.event(t.pid, { pop: { title: how === 'poison' ? 'POISONED' : 'TAKEN OUT', lines: [a ? 'by ' + a.name + ' (' + TFL.STYLES[a.style].name + ')' : 'by someone who left'], color: '#e74c3c' }, sfx: 'dead' });
      this.feed((a ? a.name : 'Someone') + ' ' + verb + ' ' + t.name + (a ? ' (+' + pts + ')' : ''));
    }

    // ---- abilities -------------------------------------------------------
    ability(a, k) {
      if (a.state !== 'alive' || a.stun > 0 || a.lock > 0 || a.cds[k] > 0) return;
      if (k === 'dust') {
        a.cds.dust = C.DUST_CD;
        for (const o of this.players.values()) {
          if (o === a || o.state !== 'alive' || dist(o, a) > C.DUST_RANGE) continue;
          o.stun = Math.max(o.stun, C.DUST_STUN);
          this.event(o.pid, { pop: { title: 'DUSTED', lines: ['Someone kicked dust in your face.'], color: '#e67e22' }, sfx: 'bad' });
        }
        for (const n of this.npcs) if (n.down <= 0 && dist(n, a) < C.DUST_RANGE) n.down = 2;
        // Everyone sees the cloud — it's an escape, not a disguise.
        this.fx({ k: 'dust', x: Math.round(a.x), y: Math.round(a.y) });
      } else if (k === 'clone') {
        let c = 0;
        for (const n of this.npcs) {
          if (n.down <= 0 && dist(n, a) < C.CLONE_RANGE) { n.cloneStyle = a.style; n.cloneT = C.CLONE_TIME; c++; }
        }
        if (!c) { this.event(a.pid, { pop: { title: 'NOBODY TO CLONE', lines: ['Get into a crowd first.'], color: '#95a5a6' } }); return; }
        a.cds.clone = C.CLONE_CD;
        this.shake(a);
        this.event(a.pid, { pop: { title: 'CLONED', lines: [c + ' people nearby now look just like you for ' + C.CLONE_TIME + 's.'], color: '#9b8cf0' }, sfx: 'contract', fx: { k: 'clone', x: Math.round(a.x), y: Math.round(a.y) } });
      } else if (k === 'decoy') {
        const cands = this.npcs.filter((n) => n.down <= 0 && n.decoyT <= 0 && dist(n, a) < C.DECOY_RANGE);
        if (!cands.length) { this.event(a.pid, { pop: { title: 'NO DECOY', lines: ['Nobody close enough to send running.'], color: '#95a5a6' } }); return; }
        // prefer someone already wearing your look
        const same = cands.filter((n) => (n.cloneT > 0 ? n.cloneStyle : n.style) === a.style);
        const n = pick(same.length ? same : cands);
        n.decoyT = C.DECOY_TIME;
        n.decoyFrom = { x: a.x, y: a.y };
        n.idle = 0; n.follow = null;
        n.cloneStyle = a.style;
        n.cloneT = Math.max(n.cloneT, C.DECOY_TIME);
        a.cds.decoy = C.DECOY_CD;
        this.arrive(n);
        this.shake(a);
        this.event(a.pid, { pop: { title: 'DECOY', lines: ['Someone in your look just bolted. Your hunters lose track of you.'], color: '#9b8cf0' }, sfx: 'contract', fx: { k: 'decoy', id: n.id } });
      }
    }

    /** Clone and decoy throw off anyone who had you identified. */
    shake(a) {
      if (a.revealed > 0) return;
      for (const h of this.players.values()) if (h.target === a.pid) h.idProg = 0;
    }

    removePlayer(pid) {
      const p = this.players.get(pid);
      if (!p) return;
      this.players.delete(pid);
      for (const o of this.players.values()) {
        if (o.target === pid) { o.target = null; o.contractT = C.NEW_CONTRACT; }
        if (o.poisoner === pid) o.poisoner = null;
      }
      for (const n of this.npcs) if (n.follow === p) n.follow = null;
      this.feed(p.name + ' left the kasi');
      if (!this.over && this.players.size < 2) this.finish();
    }

    // ---- output ----------------------------------------------------------
    event(pid, ev) {
      this.send(pid, Object.assign({ t: 'ev' }, ev));
    }

    fx(f) {
      for (const pid of this.players.keys()) this.send(pid, { t: 'ev', fx: f });
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
      const list = [];
      for (const n of this.npcs) {
        list.push([n.id, Math.round(n.x), Math.round(n.y), n.cloneT > 0 ? n.cloneStyle : n.style, n.down > 0 ? 1 : 0]);
      }
      const players = [...this.players.values()];
      for (const p of players) {
        list.push([p.id, Math.round(p.x), Math.round(p.y), p.style, (p.state === 'dead' ? 1 : 0) | (p.stun > 0 ? 2 : 0) | (p.lock > 0 ? 8 : 0)]);
      }
      // Sort by id so a player's position in the list gives nothing away,
      // then flatten to [id,x,y,style,flags, id,x,y,...] to keep packets small.
      list.sort((a, b) => a[0] - b[0]);
      const ents = [].concat(...list);
      const sb = this.scoreboard().map((s) => [s.name, s.score, s.style]);
      const tl = Math.max(0, Math.ceil(this.timeLeft));

      for (const p of players) {
        const me = {
          id: p.id, tp: p.tp, x: Math.round(p.x), y: Math.round(p.y),
          st: p.state === 'dead' ? 1 : p.stun > 0 ? 2 : p.lock > 0 ? 3 : 0,
          rs: Math.ceil(p.respawn), cd: +p.cooldown.toFixed(1), sc: p.score,
          bl: p.hidden ? 1 : 0, sp: p.spot >= 0 ? 1 : 0, ex: p.exposed > 0 ? 1 : 0, rv: p.revealed > 0 ? 1 : 0,
          cds: { du: Math.ceil(p.cds.dust), po: Math.ceil(p.cds.poison), cl: Math.ceil(p.cds.clone), de: Math.ceil(p.cds.decoy) },
          calm: p.sinceSprint >= C.CALM_TIME ? 1 : 0,
          tgt: null, ct: p.target ? 0 : Math.max(0, Math.ceil(p.contractT)),
          hn: 0, hb: 0, exp: [],
        };
        const t = p.target && this.players.get(p.target);
        if (t && p.state === 'alive') {
          const d = dist(p, t);
          const locked = p.idProg >= C.ID_TIME || (t.revealed > 0 && t.state === 'alive');
          const b = locked ? 3 : d < C.CLOSE_RANGE ? 2 : d < C.FAR_RANGE ? 1 : 0;
          me.tgt = { s: t.style, n: t.name, b };
          // Far away you only get one of eight rough directions; close up you
          // get none at all and have to pick them out of the crowd yourself.
          if (b < 2) me.tgt.a = Math.round(Math.atan2(t.y - p.y, t.x - p.x) / (Math.PI / 4));
          if (b === 2) { me.tgt.ip = +(p.idProg / C.ID_TIME).toFixed(2); me.tgt.h = t.hidden ? 1 : 0; }
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
