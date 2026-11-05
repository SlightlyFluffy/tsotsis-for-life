/* Tsotsi's For Life — canvas renderer (top-down kasi). */
(function () {
  'use strict';
  const TFL = window.TFL;
  const C = TFL.C;

  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const f = (v) => Math.max(0, Math.min(255, Math.round(v + amt * 255)));
    const r = f(n >> 16), g = f((n >> 8) & 255), b = f(n & 255);
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }

  function rrect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** Draws a person centred at (0,0), facing +x after rotation. */
  function drawPerson(ctx, style, skin, facing, phase, flags, t) {
    const S = TFL.STYLES[style];
    const down = flags & 1;
    ctx.save();
    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.ellipse(3, 4, down ? 16 : 11, down ? 8 : 9, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.rotate(facing);
    if (down) {
      // lying on the ground
      ctx.fillStyle = S.pants;
      ctx.fillRect(-16, -5, 12, 10);
      ctx.fillStyle = S.shirt;
      rrect(ctx, -6, -8, 14, 16, 5);
      ctx.fill();
      ctx.fillStyle = skin;
      ctx.beginPath();
      ctx.arc(13, 0, 6, 0, Math.PI * 2);
      ctx.fill();
      drawHat(ctx, S, 13, 0);
      ctx.restore();
      return;
    }
    const swing = Math.sin(phase) * 5;
    // feet
    ctx.fillStyle = '#1a1a1a';
    ctx.beginPath();
    ctx.ellipse(swing, -5, 4, 3, 0, 0, Math.PI * 2);
    ctx.ellipse(-swing, 5, 4, 3, 0, 0, Math.PI * 2);
    ctx.fill();
    // arms
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.arc(-swing * 0.6, -11, 3.2, 0, Math.PI * 2);
    ctx.arc(swing * 0.6, 11, 3.2, 0, Math.PI * 2);
    ctx.fill();
    // torso
    ctx.fillStyle = S.shirt;
    ctx.strokeStyle = S.trim;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(0, 0, 7, 11, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // head
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.arc(1, 0, 6.2, 0, Math.PI * 2);
    ctx.fill();
    drawHat(ctx, S, 1, 0);
    ctx.restore();
    if (flags & 2) {
      // stunned: little stars
      for (let k = 0; k < 3; k++) {
        const a = t * 4 + (k * Math.PI * 2) / 3;
        ctx.fillStyle = '#ffe066';
        ctx.beginPath();
        ctx.arc(Math.cos(a) * 10, -16 + Math.sin(a) * 4, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function drawHat(ctx, S, hx, hy) {
    ctx.fillStyle = S.hatColor;
    ctx.strokeStyle = shade(S.hatColor, -0.25);
    ctx.lineWidth = 1;
    switch (S.hat) {
      case 'bucket':
        ctx.beginPath();
        ctx.arc(hx, hy, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = shade(S.hatColor, 0.12);
        ctx.beginPath();
        ctx.arc(hx, hy, 5, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'ivy':
        ctx.beginPath();
        ctx.ellipse(hx + 2, hy, 8, 6.5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.strokeStyle = shade(S.hatColor, 0.2);
        ctx.beginPath();
        ctx.moveTo(hx + 3, hy - 5);
        ctx.lineTo(hx + 3, hy + 5);
        ctx.stroke();
        break;
      case 'beanie':
        ctx.beginPath();
        ctx.arc(hx, hy, 6.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#c9c9c9';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(hx, hy, 5.6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = '#d33';
        ctx.beginPath();
        ctx.arc(hx, hy, 2, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'doek':
        ctx.beginPath();
        ctx.arc(hx, hy, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(hx - 7, hy, 3.5, 4.5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = shade(S.hatColor, -0.3);
        ctx.beginPath();
        ctx.arc(hx, hy, 4.5, -1, 1);
        ctx.stroke();
        break;
      case 'cap':
        ctx.beginPath();
        ctx.arc(hx, hy, 6.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.ellipse(hx + 7, hy, 4, 5, 0, -Math.PI / 2, Math.PI / 2);
        ctx.fill();
        ctx.stroke();
        break;
    }
  }

  class Renderer {
    constructor(canvas, map) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.map = map;
      this.zoom = 1;
      this.dpr = 1;
      this.groundPattern = this.makeGround();
      this.resize();
    }

    makeGround() {
      const c = document.createElement('canvas');
      c.width = c.height = 160;
      const g = c.getContext('2d');
      g.fillStyle = '#b48a5c';
      g.fillRect(0, 0, 160, 160);
      const rnd = TFL.mulberry32(7);
      for (let i = 0; i < 420; i++) {
        g.fillStyle = rnd() < 0.5 ? 'rgba(90,60,30,0.18)' : 'rgba(240,215,170,0.16)';
        const s = 1 + rnd() * 3;
        g.fillRect(rnd() * 160, rnd() * 160, s, s);
      }
      return this.ctx.createPattern(c, 'repeat');
    }

    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.dpr = dpr;
      this.zoom = Math.max(0.9, Math.max(w, h) / 820);
      this.vw = w;
      this.vh = h;
    }

    worldToScreen(x, y) {
      return { x: (x - this.cam.x) * this.zoom + this.vw / 2, y: (y - this.cam.y) * this.zoom + this.vh / 2 };
    }

    /**
     * view = { cam:{x,y}, ents:[{id,x,y,style,flags,facing,phase}], meId,
     *          targetId, exposed:Set, tgt, me, t, swing }
     */
    draw(view) {
      const ctx = this.ctx, z = this.zoom, map = this.map;
      this.cam = view.cam;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.fillStyle = '#3b2c1f';
      ctx.fillRect(0, 0, this.vw, this.vh);
      ctx.setTransform(this.dpr * z, 0, 0, this.dpr * z, this.dpr * (this.vw / 2 - view.cam.x * z), this.dpr * (this.vh / 2 - view.cam.y * z));

      const pad = 80;
      const vx0 = view.cam.x - this.vw / 2 / z - pad, vx1 = view.cam.x + this.vw / 2 / z + pad;
      const vy0 = view.cam.y - this.vh / 2 / z - pad, vy1 = view.cam.y + this.vh / 2 / z + pad;
      const vis = (x, y, w, h) => x + w > vx0 && x < vx1 && y + h > vy0 && y < vy1;

      // ground
      ctx.fillStyle = this.groundPattern;
      ctx.fillRect(0, 0, C.W, C.H);

      // zones
      for (const zn of map.zones) {
        if (!vis(zn.x, zn.y, zn.w, zn.h)) continue;
        ctx.fillStyle = zn.kind === 'park' ? '#8b9a5a' : zn.kind === 'pitch' ? '#cfae7c' : 'rgba(0,0,0,0.06)';
        ctx.fillRect(zn.x, zn.y, zn.w, zn.h);
      }

      // roads
      ctx.fillStyle = '#5a554e';
      for (const x of C.RX) ctx.fillRect(x - C.ROAD_HALF, 0, C.ROAD_HALF * 2, C.H);
      for (const y of C.RY) ctx.fillRect(0, y - C.ROAD_HALF, C.W, C.ROAD_HALF * 2);
      ctx.strokeStyle = 'rgba(30,25,20,0.35)';
      ctx.lineWidth = 3;
      for (const x of C.RX) { ctx.beginPath(); ctx.moveTo(x - C.ROAD_HALF, 0); ctx.lineTo(x - C.ROAD_HALF, C.H); ctx.moveTo(x + C.ROAD_HALF, 0); ctx.lineTo(x + C.ROAD_HALF, C.H); ctx.stroke(); }
      for (const y of C.RY) { ctx.beginPath(); ctx.moveTo(0, y - C.ROAD_HALF); ctx.lineTo(C.W, y - C.ROAD_HALF); ctx.moveTo(0, y + C.ROAD_HALF); ctx.lineTo(C.W, y + C.ROAD_HALF); ctx.stroke(); }
      ctx.strokeStyle = 'rgba(235,220,160,0.45)';
      ctx.lineWidth = 2;
      ctx.setLineDash([14, 16]);
      for (const x of C.RX) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, C.H); ctx.stroke(); }
      for (const y of C.RY) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(C.W, y); ctx.stroke(); }
      ctx.setLineDash([]);
      // intersections patch over the markings
      ctx.fillStyle = '#5a554e';
      for (const x of C.RX) for (const y of C.RY) ctx.fillRect(x - C.ROAD_HALF + 2, y - C.ROAD_HALF + 2, C.ROAD_HALF * 2 - 4, C.ROAD_HALF * 2 - 4);

      // ground decor
      for (const d of map.decor) this.drawDecorLow(ctx, d, vis);

      // zone labels (painted on the ground)
      ctx.font = 'bold 15px "Archivo Black", Impact, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const zn of map.zones) {
        if (!vis(zn.x, zn.y, zn.w, zn.h)) continue;
        ctx.fillStyle = 'rgba(255,245,220,0.35)';
        ctx.fillText(zn.name, zn.x + zn.w / 2, zn.y + zn.h - 12);
      }

      // obstacle shadows then bodies
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      for (const o of map.obstacles) if (o.kind !== 'trunk' && vis(o.x, o.y, o.w, o.h)) ctx.fillRect(o.x + 5, o.y + 6, o.w, o.h);
      for (const o of map.obstacles) if (vis(o.x, o.y, o.w, o.h)) this.drawObstacle(ctx, o);

      // overlays under feet
      for (const e of view.ents) {
        if (e.id === view.meId) {
          ctx.strokeStyle = 'rgba(255,255,255,0.85)';
          ctx.lineWidth = 2;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.arc(e.x, e.y, 16, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      // people, back to front
      const ents = view.ents.filter((e) => vis(e.x - 20, e.y - 20, 40, 40)).sort((a, b) => a.y - b.y);
      for (const e of ents) {
        ctx.save();
        ctx.translate(e.x, e.y);
        drawPerson(ctx, e.style, TFL.SKINS[TFL.hash(e.id) % TFL.SKINS.length], e.facing, e.phase, e.flags, view.t);
        ctx.restore();
      }

      // hover ring: who a click would hit (shown the same for everyone)
      if (view.hover) {
        const h = view.ents.find((e) => e.id === view.hover.id);
        if (h) {
          ctx.strokeStyle = view.hover.inReach ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.35)';
          ctx.lineWidth = 2;
          ctx.setLineDash(view.hover.inReach ? [] : [3, 4]);
          ctx.beginPath();
          ctx.arc(h.x, h.y, 15, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      // the action swing
      if (view.swing && view.swing.until > view.t) {
        const me = view.ents.find((e) => e.id === view.meId);
        if (me) {
          const k = 1 - (view.swing.until - view.t) / 0.25;
          ctx.strokeStyle = 'rgba(255,255,255,' + (0.8 - k * 0.8) + ')';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(me.x, me.y, C.ACTION_RANGE * (0.6 + k * 0.4), me.facing - 0.9, me.facing + 0.9);
          ctx.stroke();
        }
      }

      // tree canopies: you can lurk under these
      for (const tr of map.trees) {
        if (!vis(tr.x - tr.r, tr.y - tr.r, tr.r * 2, tr.r * 2)) continue;
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.beginPath();
        ctx.arc(tr.x + 6, tr.y + 7, tr.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(52,92,44,0.94)';
        ctx.beginPath();
        ctx.arc(tr.x, tr.y, tr.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(92,140,66,0.9)';
        for (let k = 0; k < 5; k++) {
          const a = k * 1.256 + tr.x;
          ctx.beginPath();
          ctx.arc(tr.x + Math.cos(a) * tr.r * 0.45, tr.y + Math.sin(a) * tr.r * 0.45, tr.r * 0.42, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      for (const d of map.decor) if (d.kind === 'washing') this.drawWashing(ctx, d, vis);

      // markers above everything
      const pulse = 0.5 + 0.5 * Math.sin(view.t * 6);
      for (const e of view.ents) {
        if (e.id === view.targetId) {
          ctx.strokeStyle = 'rgba(241,196,15,' + (0.6 + pulse * 0.4) + ')';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(e.x, e.y, 17 + pulse * 3, 0, Math.PI * 2);
          ctx.stroke();
          this.label(ctx, e.x, e.y - 28, 'TARGET', '#f1c40f');
        } else if (view.exposed.has(e.id)) {
          ctx.strokeStyle = 'rgba(231,76,60,' + (0.6 + pulse * 0.4) + ')';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(e.x, e.y, 17 + pulse * 3, 0, Math.PI * 2);
          ctx.stroke();
          this.label(ctx, e.x, e.y - 28, 'HUNTER', '#e74c3c');
        }
      }

      // contract compass around me — deliberately vague
      const me = view.ents.find((e) => e.id === view.meId);
      if (me && view.tgt && view.tgt.b < 2 && view.tgt.a !== undefined) {
        const a = view.tgt.a * (Math.PI / 4), r = 40, spread = Math.PI / 8 + 0.08;
        const col = view.tgt.b === 0 ? 'rgba(220,220,220,0.35)' : 'rgba(241,196,15,0.45)';
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.moveTo(me.x + Math.cos(a - spread) * 22, me.y + Math.sin(a - spread) * 22);
        ctx.arc(me.x, me.y, r + 14, a - spread, a + spread);
        ctx.arc(me.x, me.y, 22, a + spread, a - spread, true);
        ctx.closePath();
        ctx.fill();
      } else if (me && view.tgt && view.tgt.b === 2) {
        // they're close, but which way? You'll have to look.
        const k = (view.t * 0.8) % 1;
        ctx.strokeStyle = 'rgba(241,170,15,' + (0.55 * (1 - k)) + ')';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(me.x, me.y, 22 + k * 60, 0, Math.PI * 2);
        ctx.stroke();
      }

      // dust clouds
      for (const f of view.fx || []) {
        const k = (view.t - f.at) / 1.2;
        if (k < 0 || k > 1) continue;
        for (let i = 0; i < 9; i++) {
          const ang = i * 0.7 + f.x;
          const rr = C.DUST_RANGE * (0.3 + k * 0.8) * (0.6 + (i % 3) * 0.2);
          ctx.fillStyle = 'rgba(214,180,130,' + 0.55 * (1 - k) + ')';
          ctx.beginPath();
          ctx.arc(f.x + Math.cos(ang) * rr * 0.6, f.y + Math.sin(ang) * rr * 0.6, rr * 0.55, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // darken outside the world edge
      ctx.fillStyle = '#2a1f16';
      ctx.fillRect(-2000, -2000, C.W + 4000, 2000);
      ctx.fillRect(-2000, C.H, C.W + 4000, 2000);
      ctx.fillRect(-2000, 0, 2000, C.H);
      ctx.fillRect(C.W, 0, 2000, C.H);
    }

    label(ctx, x, y, text, color) {
      ctx.font = 'bold 10px "Archivo Black", Impact, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const w = ctx.measureText(text).width + 10;
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      rrect(ctx, x - w / 2, y - 7, w, 14, 4);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.fillText(text, x, y + 0.5);
    }

    drawObstacle(ctx, o) {
      if (o.kind === 'shack') {
        ctx.fillStyle = o.color;
        ctx.fillRect(o.x, o.y, o.w, o.h);
        ctx.strokeStyle = shade(o.color, -0.12);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        if (o.ridge === 'v') for (let x = o.x + 5; x < o.x + o.w; x += 6) { ctx.moveTo(x, o.y); ctx.lineTo(x, o.y + o.h); }
        else for (let y = o.y + 5; y < o.y + o.h; y += 6) { ctx.moveTo(o.x, y); ctx.lineTo(o.x + o.w, y); }
        ctx.stroke();
        if (o.rust) {
          ctx.fillStyle = 'rgba(140,70,30,0.45)';
          ctx.beginPath();
          ctx.ellipse(o.x + o.rust.u * o.w, o.y + o.rust.v * o.h, o.w * o.rust.s, o.h * o.rust.s * 0.7, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        if (o.tire) {
          ctx.strokeStyle = '#1b1b1b';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(o.x + o.w * 0.3, o.y + o.h * 0.35, 5, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.strokeStyle = 'rgba(0,0,0,0.45)';
        ctx.lineWidth = 2;
        ctx.strokeRect(o.x, o.y, o.w, o.h);
      } else if (o.kind === 'bus') {
        ctx.fillStyle = '#efeee8';
        rrect(ctx, o.x, o.y, o.w, o.h, 7);
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.4)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = '#2b3a46';
        ctx.fillRect(o.x + 4, o.y + 6, o.w - 8, 9);
        ctx.fillStyle = o.color;
        ctx.fillRect(o.x + 2, o.y + o.h * 0.5, o.w - 4, 5);
        ctx.strokeStyle = 'rgba(0,0,0,0.25)';
        ctx.strokeRect(o.x + 6, o.y + 22, o.w - 12, o.h - 30);
      } else if (o.kind === 'stall') {
        const stripes = 5;
        for (let k = 0; k < stripes; k++) {
          ctx.fillStyle = k % 2 ? '#f5efe0' : o.color;
          ctx.fillRect(o.x + (k * o.w) / stripes, o.y, o.w / stripes + 0.5, o.h);
        }
        ctx.strokeStyle = 'rgba(0,0,0,0.4)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(o.x, o.y, o.w, o.h);
      } else if (o.kind === 'building') {
        ctx.fillStyle = o.color;
        ctx.fillRect(o.x, o.y, o.w, o.h);
        ctx.fillStyle = shade(o.color, 0.1);
        ctx.fillRect(o.x + 6, o.y + 6, o.w - 12, o.h - 12);
        ctx.strokeStyle = 'rgba(0,0,0,0.45)';
        ctx.lineWidth = 2;
        ctx.strokeRect(o.x, o.y, o.w, o.h);
        ctx.save();
        ctx.translate(o.x + o.w / 2, o.y + o.h / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.font = 'bold 16px "Archivo Black", Impact, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillText(o.label, 0, 0);
        ctx.restore();
      } else if (o.kind === 'trunk') {
        ctx.fillStyle = '#4b3621';
        ctx.beginPath();
        ctx.arc(o.x + 7, o.y + 7, 6, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    drawDecorLow(ctx, d, vis) {
      switch (d.kind) {
        case 'pothole':
          if (!vis(d.x - 10, d.y - 10, 20, 20)) return;
          ctx.fillStyle = 'rgba(30,26,22,0.55)';
          ctx.beginPath();
          ctx.ellipse(d.x, d.y, d.r, d.r * 0.7, d.a, 0, Math.PI * 2);
          ctx.fill();
          return;
        case 'litter':
          if (!vis(d.x - 10, d.y - 10, 20, 20)) return;
          ctx.fillStyle = ['#d9d4c5', '#c0392b', '#2980b9'][Math.floor(d.r) % 3];
          ctx.save();
          ctx.translate(d.x, d.y);
          ctx.rotate(d.a);
          ctx.fillRect(-3, -2, 6, 4);
          ctx.restore();
          return;
        case 'pitch':
          if (!vis(d.x, d.y, d.w, d.h)) return;
          ctx.strokeStyle = 'rgba(255,255,255,0.45)';
          ctx.lineWidth = 2;
          ctx.strokeRect(d.x, d.y, d.w, d.h);
          ctx.beginPath();
          ctx.moveTo(d.x + d.w / 2, d.y);
          ctx.lineTo(d.x + d.w / 2, d.y + d.h);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(d.x + d.w / 2, d.y + d.h / 2, 32, 0, Math.PI * 2);
          ctx.stroke();
          ctx.strokeStyle = '#eee';
          ctx.lineWidth = 3;
          ctx.strokeRect(d.x - 2, d.y + d.h / 2 - 22, 8, 44);
          ctx.strokeRect(d.x + d.w - 6, d.y + d.h / 2 - 22, 8, 44);
          return;
        case 'grass':
          return;
        case 'bench':
          if (!vis(d.x, d.y, d.w, d.h)) return;
          ctx.fillStyle = '#6e4b2a';
          ctx.fillRect(d.x, d.y, d.w, d.h);
          return;
        case 'shelter':
          if (!vis(d.x, d.y, d.w, d.h)) return;
          ctx.fillStyle = '#7f8c8d';
          ctx.fillRect(d.x, d.y, d.w, d.h);
          return;
        case 'drum':
          if (!vis(d.x - 10, d.y - 10, 20, 20)) return;
          ctx.fillStyle = '#333';
          ctx.beginPath();
          ctx.arc(d.x, d.y, 9, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#e67e22';
          ctx.beginPath();
          ctx.arc(d.x, d.y, 5, 0, Math.PI * 2);
          ctx.fill();
          return;
        case 'crate':
          if (!vis(d.x - 10, d.y - 10, 20, 20)) return;
          ctx.fillStyle = '#c0392b';
          ctx.fillRect(d.x - 7, d.y - 6, 14, 12);
          ctx.fillStyle = '#e8c547';
          ctx.fillRect(d.x + 9, d.y - 6, 14, 12);
          return;
        case 'tank':
          if (!vis(d.x - 10, d.y - 10, 20, 20)) return;
          ctx.fillStyle = '#2c3e50';
          ctx.beginPath();
          ctx.arc(d.x + 6, d.y + 6, 7, 0, Math.PI * 2);
          ctx.fill();
          return;
      }
    }

    drawWashing(ctx, d, vis) {
      if (!vis(Math.min(d.x1, d.x2), Math.min(d.y1, d.y2) - 10, Math.abs(d.x2 - d.x1), 20)) return;
      ctx.strokeStyle = 'rgba(40,40,40,0.6)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(d.x1, d.y1);
      ctx.lineTo(d.x2, d.y2);
      ctx.stroke();
      const rnd = TFL.mulberry32(d.seed);
      const n = 6 + Math.floor(rnd() * 6);
      for (let k = 0; k < n; k++) {
        const f = (k + 0.5 + (rnd() - 0.5) * 0.4) / n;
        const x = d.x1 + (d.x2 - d.x1) * f, y = d.y1 + (d.y2 - d.y1) * f;
        ctx.fillStyle = ['#e74c3c', '#ecf0f1', '#3498db', '#f39c12', '#9b59b6'][Math.floor(rnd() * 5)];
        ctx.fillRect(x - 4, y, 8, 6 + rnd() * 5);
      }
    }
  }

  TFL.Renderer = Renderer;
  TFL.drawPerson = drawPerson;

  /** Small portrait used in the lobby and the contract card. */
  TFL.drawPortrait = function (canvas, style) {
    const ctx = canvas.getContext('2d');
    const s = canvas.width / 40;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(s, 0, 0, s, canvas.width / 2, canvas.height / 2);
    drawPerson(ctx, style, '#7d4f30', -Math.PI / 2, 0, 0, 0);
  };
})();
