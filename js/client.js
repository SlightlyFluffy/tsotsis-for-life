/* Tsotsi's For Life — the playing client (every peer, host included, runs one). */
(function () {
  'use strict';
  const TFL = window.TFL;
  const C = TFL.C;
  const $ = (id) => document.getElementById(id);
  const INTERP_MS = 110;

  // ---------------------------------------------------------------- sound
  let actx = null;
  function sfx(kind) {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const notes = {
        kill: [[660, 0], [880, 0.08], [1100, 0.16]],
        stun: [[520, 0], [780, 0.07]],
        contract: [[440, 0], [554, 0.1]],
        bad: [[220, 0], [160, 0.12]],
        dead: [[300, 0], [200, 0.15], [120, 0.3]],
        alarm: [[880, 0], [660, 0.1], [880, 0.2]],
        swing: [[180, 0]],
      }[kind];
      if (!notes) return;
      for (const [f, at] of notes) {
        const o = actx.createOscillator(), g = actx.createGain();
        o.type = kind === 'swing' ? 'triangle' : 'square';
        o.frequency.value = f;
        const t0 = actx.currentTime + at;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.06, t0 + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.14);
        o.connect(g).connect(actx.destination);
        o.start(t0);
        o.stop(t0 + 0.16);
      }
    } catch (e) { /* no audio */ }
  }
  TFL.sfx = sfx;

  class GameClient {
    /** start = { seed, duration, roster:[{name,style}] }, send(msg) */
    constructor(start, send) {
      this.send = send;
      this.map = TFL.buildMap(start.seed);
      this.canvas = $('game');
      this.renderer = new TFL.Renderer(this.canvas, this.map);
      this.snaps = [];
      this.me = null;
      this.pos = null; // locally predicted position
      this.tp = 0;
      this.keys = new Set();
      this.joy = { x: 0, y: 0, active: false };
      this.touchSprint = false;
      this.facing = new Map();
      this.myFacing = 0;
      this.myPhase = 0;
      this.swing = null;
      this.lastAct = 0;
      this.feedItems = [];
      this.popQueue = [];
      this.popUntil = 0;
      this.last = performance.now();
      this.hudCache = {};
      this.destroyed = false;
      this.fx = [];
      this.startedAt = performance.now();
      $('briefing').hidden = false;
      $('help').hidden = true;
      setTimeout(() => { if (!this.destroyed) $('briefing').hidden = true; }, 12000);

      this.onKey = this.onKey.bind(this);
      this.onResize = () => this.renderer.resize();
      this.onPointer = this.onPointer.bind(this);
      this.canvas.addEventListener('pointermove', this.onPointer);
      this.canvas.addEventListener('pointerdown', this.onPointer);
      window.addEventListener('keydown', this.onKey);
      window.addEventListener('keyup', this.onKey);
      window.addEventListener('blur', () => this.keys.clear());
      window.addEventListener('resize', this.onResize);
      this.setupTouch();

      $('hud').hidden = false;
      $('feed').innerHTML = '';
      $('popup').className = 'popup';
      this.renderer.resize();
      this.ticker = TFL.makeTicker(C.TICK_MS, () => this.sendInput());
      this.frame = this.frame.bind(this);
      this.raf = requestAnimationFrame(this.frame);
    }

    destroy() {
      this.destroyed = true;
      cancelAnimationFrame(this.raf);
      this.ticker.stop();
      window.removeEventListener('keydown', this.onKey);
      window.removeEventListener('keyup', this.onKey);
      window.removeEventListener('resize', this.onResize);
      this.canvas.removeEventListener('pointermove', this.onPointer);
      this.canvas.removeEventListener('pointerdown', this.onPointer);
      $('hud').hidden = true;
      $('vignette').style.opacity = 0;
    }

    // ---- input -----------------------------------------------------------
    onKey(e) {
      if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
      const k = e.key.toLowerCase();
      const handled = ['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift', 'tab', 'q', 'h', '?'];
      if (!handled.includes(k)) return;
      e.preventDefault();
      if (e.type === 'keydown') {
        if (k === 'q' && !e.repeat) this.dust();
        if ((k === 'h' || k === '?') && !e.repeat) $('help').hidden = !$('help').hidden;
        if (/^[wasd]$|^arrow/.test(k) && performance.now() - this.startedAt > 2500) $('briefing').hidden = true;
        if (k === 'tab') $('scoreboard').classList.add('expanded');
        this.keys.add(k);
      } else {
        if (k === 'tab') $('scoreboard').classList.remove('expanded');
        this.keys.delete(k);
      }
    }

    /** Which body is under this screen point (CSS px)? */
    pickAt(sx, sy) {
      const r = this.renderer;
      if (!r.cam || !this.lastEnts) return null;
      const wx = (sx - r.vw / 2) / r.zoom + r.cam.x, wy = (sy - r.vh / 2) / r.zoom + r.cam.y;
      let best = null, bd = 18;
      for (const e of this.lastEnts) {
        if (e.id === this.me.id || e.flags & 1) continue;
        const d = Math.hypot(e.x - wx, e.y - wy);
        if (d < bd) { bd = d; best = e; }
      }
      return best;
    }

    act(sx, sy) {
      const now = performance.now();
      if (now - this.lastAct < 300 || !this.me || this.me.st !== 0) return;
      const e = this.pickAt(sx, sy);
      if (!e) return;
      this.lastAct = now;
      this.myFacing = Math.atan2(e.y - this.pos.y, e.x - this.pos.x);
      this.swing = { until: now / 1000 + 0.25 };
      sfx('swing');
      this.send({ t: 'act', id: e.id });
    }

    onPointer(e) {
      const r = this.canvas.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      if (e.type === 'pointermove') { this.mouse = { x: sx, y: sy }; return; }
      if (e.type === 'pointerdown' && e.button === 0) { this.mouse = { x: sx, y: sy }; this.act(sx, sy); }
    }

    dust() {
      if (!this.me || this.me.st !== 0 || this.me.dc > 0) return;
      this.send({ t: 'dust' });
    }

    setupTouch() {
      const pad = $('joystick'), knob = $('joyKnob');
      if (!pad || pad.dataset.bound) return;
      pad.dataset.bound = '1';
      let id = null, cx = 0, cy = 0;
      const R = 50;
      const move = (t) => {
        let dx = t.clientX - cx, dy = t.clientY - cy;
        const d = Math.hypot(dx, dy);
        if (d > R) { dx *= R / d; dy *= R / d; }
        knob.style.transform = `translate(${dx}px, ${dy}px)`;
        TFL.touch.x = dx / R;
        TFL.touch.y = dy / R;
      };
      pad.addEventListener('touchstart', (e) => {
        const t = e.changedTouches[0];
        id = t.identifier;
        const r = pad.getBoundingClientRect();
        cx = r.left + r.width / 2;
        cy = r.top + r.height / 2;
        move(t);
        e.preventDefault();
      }, { passive: false });
      pad.addEventListener('touchmove', (e) => {
        for (const t of e.changedTouches) if (t.identifier === id) move(t);
        e.preventDefault();
      }, { passive: false });
      const end = (e) => {
        for (const t of e.changedTouches) if (t.identifier === id) {
          id = null;
          TFL.touch.x = TFL.touch.y = 0;
          knob.style.transform = '';
        }
      };
      pad.addEventListener('touchend', end);
      pad.addEventListener('touchcancel', end);
      const sprint = $('btnSprint');
      sprint.addEventListener('touchstart', (e) => { TFL.touch.sprint = true; sprint.classList.add('on'); e.preventDefault(); }, { passive: false });
      sprint.addEventListener('touchend', () => { TFL.touch.sprint = false; sprint.classList.remove('on'); });
      $('btnDust').addEventListener('touchstart', (e) => { TFL.client && TFL.client.dust(); e.preventDefault(); }, { passive: false });
    }

    inputDir() {
      let x = 0, y = 0;
      const k = this.keys;
      if (k.has('w') || k.has('arrowup')) y -= 1;
      if (k.has('s') || k.has('arrowdown')) y += 1;
      if (k.has('a') || k.has('arrowleft')) x -= 1;
      if (k.has('d') || k.has('arrowright')) x += 1;
      x += TFL.touch.x;
      y += TFL.touch.y;
      const d = Math.hypot(x, y);
      if (d > 1) { x /= d; y /= d; }
      return { x, y, sprint: k.has('shift') || TFL.touch.sprint };
    }

    sendInput() {
      if (!this.pos || this.destroyed) return;
      const d = this.inputDir();
      const mv = Math.hypot(d.x, d.y) > 0.1;
      this.send({ t: 'in', x: Math.round(this.pos.x * 10) / 10, y: Math.round(this.pos.y * 10) / 10, sp: d.sprint && mv ? 1 : 0, mv: mv ? 1 : 0, tp: this.tp });
    }

    // ---- network ---------------------------------------------------------
    onMessage(m) {
      if (m.t === 's') {
        this.me = m.me;
        if (m.me.tp !== this.tp || !this.pos) {
          this.tp = m.me.tp;
          this.pos = { x: m.me.x, y: m.me.y };
        } else if (Math.hypot(m.me.x - this.pos.x, m.me.y - this.pos.y) > 60) {
          // host disagreed a lot (e.g. we were frozen); trust the host
          this.pos = { x: m.me.x, y: m.me.y };
        }
        const ents = new Map();
        for (let i = 0; i < m.e.length; i += 5) ents.set(m.e[i], m.e.slice(i, i + 5));
        this.snaps.push({ at: performance.now(), ents });
        if (this.snaps.length > 12) this.snaps.shift();
        this.timeLeft = m.tl;
        this.sb = m.sb;
      } else if (m.t === 'ev') {
        if (m.feed) this.addFeed(m.feed);
        if (m.pop) this.popQueue.push(m.pop);
        if (m.sfx) sfx(m.sfx);
        if (m.fx) this.fx.push(Object.assign({ at: performance.now() / 1000 }, m.fx));
      }
    }

    addFeed(text) {
      const el = document.createElement('div');
      el.className = 'feed-item';
      el.textContent = text;
      const feed = $('feed');
      feed.prepend(el);
      while (feed.children.length > 5) feed.lastChild.remove();
      setTimeout(() => el.classList.add('fade'), 6000);
      setTimeout(() => el.remove(), 7000);
    }

    // ---- frame -----------------------------------------------------------
    interpolated(now) {
      const rt = now - INTERP_MS;
      const s = this.snaps;
      if (!s.length) return [];
      let a = s[0], b = s[s.length - 1];
      for (let i = s.length - 1; i > 0; i--) {
        if (s[i - 1].at <= rt) { a = s[i - 1]; b = s[i]; break; }
      }
      const span = b.at - a.at;
      const k = span > 0 ? Math.max(0, Math.min(1, (rt - a.at) / span)) : 1;
      const out = [];
      for (const [id, eb] of b.ents) {
        const ea = a.ents.get(id) || eb;
        let x = ea[1] + (eb[1] - ea[1]) * k, y = ea[2] + (eb[2] - ea[2]) * k;
        if (Math.abs(eb[1] - ea[1]) + Math.abs(eb[2] - ea[2]) > 150) { x = eb[1]; y = eb[2]; }
        out.push({ id, x, y, style: eb[3], flags: k < 0.5 ? ea[4] : eb[4] });
      }
      return out;
    }

    frame(now) {
      if (this.destroyed) return;
      this.raf = requestAnimationFrame(this.frame);
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      const t = now / 1000;

      // local movement (prediction)
      let moving = false;
      if (this.pos && this.me && this.me.st === 0) {
        const d = this.inputDir();
        const sp = d.sprint ? C.SPRINT : C.WALK;
        if (Math.hypot(d.x, d.y) > 0.1) {
          moving = true;
          TFL.moveCircle(this.map, this.pos, d.x * sp * dt, d.y * sp * dt, C.R);
          this.myFacing = Math.atan2(d.y, d.x);
          this.myPhase += sp * dt * 0.16;
        }
      }

      this.moving = moving;
      const ents = this.interpolated(now);
      const meId = this.me && this.me.id;
      for (const e of ents) {
        if (e.id === meId && this.pos && !(e.flags & 1)) {
          e.x = this.pos.x;
          e.y = this.pos.y;
          e.facing = this.myFacing;
          e.phase = moving ? this.myPhase : 0;
          continue;
        }
        let f = this.facing.get(e.id);
        if (!f) { f = { x: e.x, y: e.y, a: Math.random() * 6.28, p: 0 }; this.facing.set(e.id, f); }
        const dx = e.x - f.x, dy = e.y - f.y, d = Math.hypot(dx, dy);
        if (d > 0.15 && d < 40) { f.a = Math.atan2(dy, dx); f.p += d * 0.16; }
        f.x = e.x; f.y = e.y;
        e.facing = f.a;
        e.phase = d > 0.15 ? f.p : 0;
      }

      this.lastEnts = ents;
      let hover = null;
      if (this.mouse && this.me && this.me.st === 0 && this.pos) {
        const h = this.pickAt(this.mouse.x, this.mouse.y);
        if (h) hover = { id: h.id, inReach: Math.hypot(h.x - this.pos.x, h.y - this.pos.y) < C.ACTION_RANGE + 6 };
      }
      this.hover = hover;

      const camSrc = this.pos || { x: C.W / 2, y: C.H / 2 };
      const cam = this.cam || { x: camSrc.x, y: camSrc.y };
      cam.x += (camSrc.x - cam.x) * Math.min(1, dt * 10);
      cam.y += (camSrc.y - cam.y) * Math.min(1, dt * 10);
      this.cam = cam;

      const me = this.me;
      this.renderer.draw({
        cam, ents, meId, t,
        targetId: me && me.tgt && me.tgt.id,
        exposed: new Set(me ? me.exp : []),
        tgt: me && me.tgt,
        swing: this.swing,
        fx: this.fx,
        hover: this.hover,
      });
      this.updateHud(now);
    }

    updateActionBar(me) {
      // E: tell the player what E would do *right now*, without leaking who
      // anyone is (only uses things they already know: a locked target or an
      // exposed hunter).
      let eLabel = 'Take out / Klap', eState = '';
      const myEnt = this.pos;
      const near = (id) => {
        if (!id || !myEnt) return false;
        const s = this.snaps[this.snaps.length - 1];
        const e = s && s.ents.get(id);
        return e && Math.hypot(e[1] - myEnt.x, e[2] - myEnt.y) < C.ACTION_RANGE;
      };
      if (me.st !== 0) { eState = 'off'; eLabel = me.st === 1 ? 'Down' : 'Stunned'; }
      else if (me.cd > 0.5) { eState = 'off'; eLabel = 'Wait ' + Math.ceil(me.cd) + 's'; }
      else if (!me.calm || (this.moving && this.inputDir().sprint)) { eState = 'off'; eLabel = 'Too loud — walk'; }
      else if (me.tgt && near(me.tgt.id)) { eState = 'ready'; eLabel = 'Click them: TAKE OUT'; }
      else if (me.exp.some(near)) { eState = 'ready'; eLabel = 'Click them: KLAP'; }
      else if (this.hover && this.hover.inReach) { eLabel = 'Click to strike'; }
      this.setText('abELabel', eLabel);
      $('abE').dataset.state = eState;
      const dc = me.dc || 0;
      this.setText('abQLabel', dc > 0 ? 'Kick dust ' + dc + 's' : 'Kick dust');
      $('abQ').dataset.state = me.st !== 0 || dc > 0 ? 'off' : '';
      $('abShift').dataset.state = this.moving && this.inputDir().sprint ? 'warn' : '';
    }

    setText(id, text) {
      if (this.hudCache[id] === text) return;
      this.hudCache[id] = text;
      $(id).textContent = text;
    }

    setHtml(id, html) {
      if (this.hudCache[id] === html) return;
      this.hudCache[id] = html;
      $(id).innerHTML = html;
    }

    updateHud(now) {
      const me = this.me;
      if (!me) return;
      const tl = this.timeLeft || 0;
      this.setText('timer', Math.floor(tl / 60) + ':' + String(tl % 60).padStart(2, '0'));
      $('timer').classList.toggle('low', tl <= 30);

      if (this.sb) {
        this.setHtml('scoreboard', this.sb.map((r, i) => `<div class="sb-row"><span class="sb-rank">${i + 1}</span><span class="sb-dot" style="background:${TFL.STYLES[r[2]].shirt}"></span><span class="sb-name">${TFL.esc(r[0])}</span><span class="sb-score">${r[1]}</span></div>`).join(''));
      }

      // contract card
      const tg = me.tgt;
      const key = tg ? 'T' + tg.s + tg.n : 'none';
      if (this.hudCache.portrait !== key) {
        this.hudCache.portrait = key;
        const pc = $('targetPortrait');
        if (tg) TFL.drawPortrait(pc, tg.s);
        else pc.getContext('2d').clearRect(0, 0, pc.width, pc.height);
        $('targetCard').classList.toggle('empty', !tg);
      }
      if (tg) {
        this.setText('targetName', tg.n);
        this.setText('targetLook', 'Look for: ' + TFL.STYLES[tg.s].name);
        let band = ['Far away — follow the wedge', 'Getting warmer', 'Close — pick them out of the crowd', 'IDENTIFIED — walk up and click them'][tg.b];
        if (tg.b === 2 && tg.h) band = 'Close, but blending in — can’t make them out';
        else if (tg.b === 2 && tg.ip > 0) band = 'Identifying… keep watching';
        this.setText('targetBand', band);
        $('idBar').style.width = (tg.b === 3 ? 100 : tg.b === 2 ? Math.round((tg.ip || 0) * 100) : 0) + '%';
        $('targetBand').dataset.b = tg.b;
      } else {
        this.setText('targetName', me.st === 1 ? '—' : 'Waiting for a contract');
        this.setText('targetLook', me.ct > 0 ? 'New contract in ' + me.ct + 's' : '');
        this.setText('targetBand', '');
        $('idBar').style.width = '0%';
      }
      this.updateActionBar(me);

      // hunters
      const hbText = ['', 'Somewhere out there', 'Getting close', 'RIGHT ON YOU'][me.hb];
      this.setText('huntCount', me.hn ? String(me.hn) : '0');
      this.setText('huntInfo', me.hn ? hbText || 'Somewhere out there' : 'Nobody — for now');
      $('huntCard').dataset.b = me.hn ? me.hb : -1;
      const vig = me.hn && me.hb >= 2 ? (me.hb === 3 ? 0.55 + 0.25 * Math.sin(now / 120) : 0.3) : 0;
      $('vignette').style.opacity = vig;

      // status chips
      const chips = [];
      if (me.st === 0) {
        if (me.bl) chips.push('<span class="chip good">BLENDED</span>');
        if (this.moving && this.inputDir().sprint) chips.push('<span class="chip warn">SPRINTING — conspicuous</span>');
        if (me.ex) chips.push('<span class="chip bad">EXPOSED</span>');
        if (me.cd > 0.5) chips.push('<span class="chip warn">CAN’T STRIKE ' + me.cd.toFixed(0) + 's</span>');
        if (me.rv) chips.push('<span class="chip bad">REVEALED TO YOUR HUNTERS</span>');
      }
      if (me.st === 2) chips.push('<span class="chip bad">STUNNED</span>');
      this.setHtml('status', chips.join(''));
      this.setText('myScore', String(me.sc));

      // death overlay
      const dead = me.st === 1;
      $('deathScreen').hidden = !dead;
      if (dead) this.setText('respawnIn', String(Math.max(0, me.rs)));

      // popups
      if (now > this.popUntil && this.popQueue.length) {
        const p = this.popQueue.shift();
        const el = $('popup');
        el.innerHTML = `<div class="pop-title" style="color:${p.color}">${TFL.esc(p.title)}</div>` + (p.lines || []).map((l) => `<div class="pop-line">${TFL.esc(l)}</div>`).join('');
        el.className = 'popup show';
        this.popUntil = now + (this.popQueue.length ? 1600 : 2600);
        clearTimeout(this.popTimer);
        this.popTimer = setTimeout(() => { el.className = 'popup'; }, this.popQueue.length ? 1500 : 2500);
      }
    }
  }

  TFL.touch = { x: 0, y: 0, sprint: false };
  TFL.GameClient = GameClient;
})();
