/* Tsotsi's For Life — third-person 3D renderer (three.js).
 * The simulation stays 2D: world (x, y) becomes three.js (x, height, y). */
(function () {
  'use strict';
  const TFL = window.TFL;
  const C = TFL.C;

  TFL.webglOk = function () {
    if (!window.THREE) return false;
    try {
      const c = document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl'));
    } catch (e) { return false; }
  };

  // ------------------------------------------------------------ helpers
  /** Merge a few (possibly indexed) geometries into one non-indexed geometry. */
  function merge(geos) {
    const pos = [], nor = [];
    for (const g0 of geos) {
      const g = g0.index ? g0.toNonIndexed() : g0;
      pos.push(...g.attributes.position.array);
      nor.push(...g.attributes.normal.array);
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    return out;
  }

  function textTexture(text, color, w = 256, h = 64, bg = 'rgba(0,0,0,0.7)') {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    if (bg) {
      g.fillStyle = bg;
      const r = h / 3;
      g.beginPath();
      g.moveTo(r, 0); g.arcTo(w, 0, w, h, r); g.arcTo(w, h, 0, h, r); g.arcTo(0, h, 0, 0, r); g.arcTo(0, 0, w, 0, r);
      g.fill();
    }
    g.font = 'bold ' + Math.round(h * 0.55) + 'px "Archivo Black", Impact, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = color;
    g.fillText(text, w / 2, h / 2 + 2);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  function stripeTexture(colors, n, vertical) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    for (let i = 0; i < n; i++) {
      g.fillStyle = colors[i % colors.length];
      if (vertical) g.fillRect((i * 64) / n, 0, 64 / n + 1, 64);
      else g.fillRect(0, (i * 64) / n, 64, 64 / n + 1);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  }

  function softDot() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(32, 32, 2, 32, 32, 30);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  }

  const H_PERSON = 36;

  class Renderer3D {
    constructor(canvas, map) {
      this.canvas = canvas;
      this.map = map;
      this.is3d = true;
      const r = (this.gl = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' }));
      r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      r.shadowMap.enabled = true;
      r.shadowMap.type = THREE.PCFSoftShadowMap;
      r.outputColorSpace = THREE.SRGBColorSpace;

      const scene = (this.scene = new THREE.Scene());
      scene.background = new THREE.Color('#e9c99b');
      scene.fog = new THREE.Fog('#e3c497', 260, 1150);
      this.camera = new THREE.PerspectiveCamera(62, 1, 1, 3000);

      scene.add(new THREE.HemisphereLight('#fff3dc', '#7a5634', 1.25));
      const sun = (this.sun = new THREE.DirectionalLight('#fff0d4', 2.1));
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      const sc = sun.shadow.camera;
      sc.left = sc.bottom = -420; sc.right = sc.top = 420; sc.near = 10; sc.far = 1600;
      sun.shadow.bias = -0.0006;
      scene.add(sun, sun.target);

      this.obstacleTops = new Map(); // obstacle -> height, for camera collision
      this.buildGround();
      this.buildWorld();
      this.buildPeople();
      this.buildMarkers();
      this.particles = [];
      this.seenFx = new WeakSet();
      this.raycaster = new THREE.Raycaster();
      this.resize();
    }

    resize() {
      const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
      this.gl.setSize(w, h, false);
      this.camera.aspect = w / Math.max(1, h);
      // portrait phones need a wider lens to see anything either side
      this.camera.fov = this.camera.aspect < 1 ? 80 : 62;
      this.camera.updateProjectionMatrix();
      this.vw = w; this.vh = h;
    }

    // ---------------------------------------------------------- ground
    buildGround() {
      const map = this.map;
      const S = 1.5;
      const c = document.createElement('canvas');
      c.width = C.W * S; c.height = C.H * S;
      const ctx = c.getContext('2d');
      ctx.setTransform(S, 0, 0, S, 0, 0);
      // ground: reuse the 2D renderer's painting for roads, markings and decals
      const g2 = Object.create(TFL.Renderer.prototype);
      g2.ctx = ctx;
      const pat = TFL.Renderer.prototype.makeGround.call(g2);
      ctx.fillStyle = pat;
      ctx.fillRect(0, 0, C.W, C.H);
      for (const zn of map.zones) {
        ctx.fillStyle = zn.kind === 'park' ? '#8b9a5a' : zn.kind === 'pitch' ? '#cfae7c' : 'rgba(0,0,0,0.06)';
        ctx.fillRect(zn.x, zn.y, zn.w, zn.h);
      }
      ctx.fillStyle = '#5a554e';
      for (const x of C.RX) ctx.fillRect(x - C.ROAD_HALF, 0, C.ROAD_HALF * 2, C.H);
      for (const y of C.RY) ctx.fillRect(0, y - C.ROAD_HALF, C.W, C.ROAD_HALF * 2);
      ctx.strokeStyle = 'rgba(30,25,20,0.35)';
      ctx.lineWidth = 3;
      for (const x of C.RX) { ctx.beginPath(); ctx.moveTo(x - C.ROAD_HALF, 0); ctx.lineTo(x - C.ROAD_HALF, C.H); ctx.moveTo(x + C.ROAD_HALF, 0); ctx.lineTo(x + C.ROAD_HALF, C.H); ctx.stroke(); }
      for (const y of C.RY) { ctx.beginPath(); ctx.moveTo(0, y - C.ROAD_HALF); ctx.lineTo(C.W, y - C.ROAD_HALF); ctx.moveTo(0, y + C.ROAD_HALF); ctx.lineTo(C.W, y + C.ROAD_HALF); ctx.stroke(); }
      ctx.strokeStyle = 'rgba(235,220,160,0.5)';
      ctx.lineWidth = 2;
      ctx.setLineDash([14, 16]);
      for (const x of C.RX) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, C.H); ctx.stroke(); }
      for (const y of C.RY) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(C.W, y); ctx.stroke(); }
      ctx.setLineDash([]);
      ctx.fillStyle = '#5a554e';
      for (const x of C.RX) for (const y of C.RY) ctx.fillRect(x - C.ROAD_HALF + 2, y - C.ROAD_HALF + 2, C.ROAD_HALF * 2 - 4, C.ROAD_HALF * 2 - 4);
      const all = () => true;
      for (const d of map.decor) if (['pothole', 'litter', 'pitch'].includes(d.kind)) TFL.Renderer.prototype.drawDecorLow.call(g2, ctx, d, all);
      for (const s of map.spots) if (s.kind === 'mielies') { ctx.fillStyle = '#6d5a2e'; ctx.fillRect(s.x - 3, s.y - 3, s.w + 6, s.h + 6); }
      ctx.font = 'bold 18px "Archivo Black", Impact, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const zn of map.zones) {
        ctx.fillStyle = 'rgba(255,245,220,0.4)';
        ctx.fillText(zn.name, zn.x + zn.w / 2, zn.y + zn.h - 14);
      }
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = this.gl.capabilities.getMaxAnisotropy();
      const geo = new THREE.PlaneGeometry(C.W, C.H);
      geo.rotateX(-Math.PI / 2);
      const ground = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: tex }));
      ground.position.set(C.W / 2, 0, C.H / 2);
      ground.receiveShadow = true;
      this.scene.add(ground);
      // dusty veld beyond the edge
      const outer = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: '#9c7a52' }));
      outer.position.set(C.W / 2, -0.5, C.H / 2);
      this.scene.add(outer);
      // a low wall/fence round the kasi so the edge reads as an edge
      const fenceMat = new THREE.MeshLambertMaterial({ color: '#8a8f96' });
      const f = (x, z, w, d) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, 14, d), fenceMat); m.position.set(x, 7, z); m.castShadow = true; this.scene.add(m); };
      f(C.W / 2, -3, C.W, 4); f(C.W / 2, C.H + 3, C.W, 4); f(-3, C.H / 2, 4, C.H); f(C.W + 3, C.H / 2, 4, C.H);
    }

    // ---------------------------------------------------------- the kasi
    buildWorld() {
      const scene = this.scene, map = this.map;
      const corr = stripeTexture(['#ffffff', '#cfcfcf', '#e6e6e6', '#bdbdbd'], 16, true);
      const mats = new Map();
      const lambert = (color, tex) => {
        const k = color + (tex ? tex.uuid : '');
        if (!mats.has(k)) mats.set(k, new THREE.MeshLambertMaterial({ color, map: tex || null }));
        return mats.get(k);
      };
      const box = (w, h, d, mat, x, y, z, parent) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
        m.position.set(x, y, z);
        m.castShadow = true;
        m.receiveShadow = true;
        (parent || scene).add(m);
        return m;
      };
      const shade = (hex, amt) => {
        const c = new THREE.Color(hex);
        c.offsetHSL(0, 0, amt);
        return '#' + c.getHexString();
      };

      for (const o of map.obstacles) {
        const cx = o.x + o.w / 2, cz = o.y + o.h / 2;
        const hsh = TFL.hash(Math.round(o.x * 7 + o.y * 13));
        if (o.kind === 'shack') {
          const hw = 26 + (hsh % 9);
          const wall = box(o.w, hw, o.h, lambert(shade(o.color, -0.05), corr), cx, hw / 2, cz);
          wall.material.map.repeat.set(1, 1);
          const roof = box(o.w + 6, 3, o.h + 6, lambert(o.color, corr), cx, hw + 1.5, cz);
          roof.rotation[o.ridge === 'v' ? 'z' : 'x'] = (hsh % 2 ? 1 : -1) * 0.07;
          // door on a long side
          const door = new THREE.Mesh(new THREE.PlaneGeometry(10, 18), lambert('#3b2a1c'));
          const side = hsh % 4;
          if (side < 2) { door.position.set(cx + ((hsh >> 3) % 3 - 1) * o.w * 0.25, 9, side ? o.y + o.h + 0.3 : o.y - 0.3); door.rotation.y = side ? 0 : Math.PI; }
          else { door.position.set(side === 2 ? o.x + o.w + 0.3 : o.x - 0.3, 9, cz); door.rotation.y = side === 2 ? Math.PI / 2 : -Math.PI / 2; }
          scene.add(door);
          if (o.tire) {
            const tire = new THREE.Mesh(new THREE.TorusGeometry(4, 1.6, 6, 12), lambert('#1b1b1b'));
            tire.rotation.x = Math.PI / 2;
            tire.position.set(o.x + o.w * 0.3, hw + 4.5, o.y + o.h * 0.35);
            scene.add(tire);
          }
          this.obstacleTops.set(o, hw + 3);
        } else if (o.kind === 'bus') {
          box(o.w, 22, o.h, lambert('#efeee8'), cx, 15, cz);
          box(o.w + 0.6, 7, o.h - 10, lambert('#2b3a46'), cx, 20, cz + 2);
          box(o.w + 0.8, 3, o.h, lambert(o.color), cx, 11, cz);
          box(o.w - 8, 1.5, o.h * 0.5, lambert('#555'), cx, 26.5, cz + 6);
          const wheel = new THREE.CylinderGeometry(5, 5, 4, 12).rotateZ(Math.PI / 2);
          for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
            const m = new THREE.Mesh(wheel, lambert('#1a1a1a'));
            m.position.set(cx + dx * (o.w / 2 - 1), 5, cz + dz * (o.h / 2 - 12));
            scene.add(m);
          }
          this.obstacleTops.set(o, 28);
        } else if (o.kind === 'stall') {
          const aw = new THREE.MeshLambertMaterial({ map: stripeTexture([o.color, '#f5efe0'], 6, true) });
          box(o.w + 6, 2, o.h + 6, aw, cx, 27, cz);
          box(o.w - 4, 3, o.h - 6, lambert('#8b6a45'), cx, 12, cz);
          const fruit = ['#e74c3c', '#f39c12', '#27ae60'];
          for (let k = 0; k < 3; k++) box(6, 3, 6, lambert(fruit[k]), o.x + 8 + k * 12, 15, cz);
          for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) box(2, 26, 2, lambert('#5a4632'), o.x + 2 + dx * (o.w - 4), 13, o.y + 2 + dz * (o.h - 4));
          this.obstacleTops.set(o, 28);
        } else if (o.kind === 'building') {
          box(o.w, 40, o.h, lambert('#e3dccb'), cx, 20, cz);
          box(o.w + 0.6, 8, o.h + 0.6, lambert(o.color), cx, 8, cz);
          box(o.w + 4, 3, o.h + 4, lambert(shade(o.color, -0.1)), cx, 41.5, cz);
          const sign = new THREE.Sprite(new THREE.SpriteMaterial({ map: textTexture(o.label, '#fff', 256, 64, o.color), depthWrite: false }));
          sign.scale.set(56, 14, 1);
          sign.position.set(cx, 54, cz);
          scene.add(sign);
          this.obstacleTops.set(o, 44);
        }
      }

      // trees
      const trunkGeo = new THREE.CylinderGeometry(2.5, 3.5, 30, 7);
      const leafGeo = new THREE.IcosahedronGeometry(1, 1);
      const leafMats = [lambert('#3f6b35'), lambert('#56883f'), lambert('#4a7a3a')];
      for (const tr of map.trees) {
        const t = new THREE.Mesh(trunkGeo, lambert('#5a4128'));
        t.position.set(tr.x, 15, tr.y);
        t.castShadow = true;
        scene.add(t);
        for (let k = 0; k < 4; k++) {
          const a = k * 1.7 + tr.x, rr = k ? tr.r * 0.45 : 0;
          const m = new THREE.Mesh(leafGeo, leafMats[k % 3]);
          const s = tr.r * (k ? 0.55 : 0.7);
          m.scale.set(s, s * 0.8, s);
          m.position.set(tr.x + Math.cos(a) * rr, 40 + (k % 2) * 6, tr.y + Math.sin(a) * rr);
          m.castShadow = true;
          scene.add(m);
        }
      }

      // decor
      for (const d of map.decor) {
        if (d.kind === 'drum') {
          const m = new THREE.Mesh(new THREE.CylinderGeometry(8, 8, 16, 12), lambert('#333'));
          m.position.set(d.x, 8, d.y); m.castShadow = true; scene.add(m);
          const fire = new THREE.Mesh(new THREE.CylinderGeometry(6, 6, 1, 10), new THREE.MeshBasicMaterial({ color: '#ff8c2a' }));
          fire.position.set(d.x, 16.2, d.y); scene.add(fire);
        } else if (d.kind === 'crate') {
          box(14, 12, 12, lambert('#c0392b'), d.x, 6, d.y);
          box(14, 12, 12, lambert('#e8c547'), d.x + 16, 6, d.y);
        } else if (d.kind === 'tank') {
          const m = new THREE.Mesh(new THREE.CylinderGeometry(7, 7, 20, 12), lambert('#2c3e50'));
          m.position.set(d.x + 6, 10, d.y + 6); m.castShadow = true; scene.add(m);
        } else if (d.kind === 'bench') {
          box(d.w, 2, 10, lambert('#6e4b2a'), d.x + d.w / 2, 8, d.y + 4);
        } else if (d.kind === 'shelter') {
          box(d.w, 2, d.h + 10, lambert('#7f8c8d'), d.x + d.w / 2, 34, d.y + d.h / 2);
          for (const dx of [0, d.w]) box(2, 34, 2, lambert('#555'), d.x + dx, 17, d.y + 2);
        } else if (d.kind === 'pitch') {
          const white = lambert('#f2f2f2');
          for (const gx of [d.x, d.x + d.w]) {
            box(2, 16, 2, white, gx, 8, d.y + d.h / 2 - 22);
            box(2, 16, 2, white, gx, 8, d.y + d.h / 2 + 22);
            box(2, 2, 46, white, gx, 16, d.y + d.h / 2);
          }
        } else if (d.kind === 'washing') {
          const pts = [new THREE.Vector3(d.x1, 34, d.y1), new THREE.Vector3(d.x2, 34, d.y2)];
          scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: '#333' })));
          const rnd = TFL.mulberry32(d.seed);
          const n = 6 + Math.floor(rnd() * 6);
          for (let k = 0; k < n; k++) {
            const f = (k + 0.5) / n;
            const cloth = new THREE.Mesh(new THREE.PlaneGeometry(7, 9 + rnd() * 5), new THREE.MeshLambertMaterial({ color: ['#e74c3c', '#ecf0f1', '#3498db', '#f39c12', '#9b59b6'][Math.floor(rnd() * 5)], side: THREE.DoubleSide }));
            cloth.position.set(d.x1 + (d.x2 - d.x1) * f, 28, d.y1 + (d.y2 - d.y1) * f);
            cloth.castShadow = true;
            scene.add(cloth);
          }
        }
      }

      // hiding spots
      this.spotGroups = [];
      this.spotHit = [];
      const hitMat = new THREE.MeshBasicMaterial({ visible: false });
      const stalkGeo = new THREE.ConeGeometry(2.2, 46, 4);
      const stalkMat = lambert('#86a23c');
      map.spots.forEach((s, i) => {
        const g = new THREE.Group();
        const cx = s.x + s.w / 2, cz = s.y + s.h / 2;
        if (s.kind === 'mielies') {
          const rnd = TFL.mulberry32(s.x * 31 + s.y);
          const n = Math.round((s.w * s.h) / 34);
          const inst = new THREE.InstancedMesh(stalkGeo, stalkMat, n);
          const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
          for (let k = 0; k < n; k++) {
            e.set((rnd() - 0.5) * 0.25, rnd() * 6, (rnd() - 0.5) * 0.25);
            q.setFromEuler(e);
            const sc = 0.85 + rnd() * 0.35;
            m.compose(new THREE.Vector3(s.x + 2 + rnd() * (s.w - 4), 23 * sc, s.y + 2 + rnd() * (s.h - 4)), q, new THREE.Vector3(1, sc, 1));
            inst.setMatrixAt(k, m);
            inst.setColorAt(k, new THREE.Color().setHSL(0.2 + rnd() * 0.06, 0.45, 0.32 + rnd() * 0.12));
          }
          inst.castShadow = true;
          g.add(inst);
        } else if (s.kind === 'skip') {
          const mat = lambert('#2f5d3a');
          const H = 20;
          box(s.w, H, 2, mat, cx, H / 2, s.y + 1, g);
          box(s.w, H, 2, mat, cx, H / 2, s.y + s.h - 1, g);
          box(2, H, s.h, mat, s.x + 1, H / 2, cz, g);
          box(2, H, s.h, mat, s.x + s.w - 1, H / 2, cz, g);
          const rnd = TFL.mulberry32(s.x + s.y * 7);
          box(s.w - 4, 2, s.h - 4, lambert('#3c3a33'), cx, H - 2, cz, g);
          for (let k = 0; k < 9; k++) {
            box(4 + rnd() * 7, 3 + rnd() * 4, 4 + rnd() * 6, lambert(['#8d8a7e', '#c0392b', '#d9d4c5', '#6b5b45', '#2980b9'][Math.floor(rnd() * 5)]), s.x + 6 + rnd() * (s.w - 12), H + 1, s.y + 5 + rnd() * (s.h - 10), g);
          }
          box(8, 2, 0.5, lambert('#f1c40f'), s.x + s.w - 8, H - 4, s.y - 0.2, g);
        } else if (s.kind === 'laundry') {
          const pole = lambert('#5a4632');
          for (const dx of [s.x - 3, s.x + s.w + 3]) for (const dz of [s.y + 2, s.y + s.h - 2]) box(2, 40, 2, pole, dx, 20, dz, g);
          const cols = ['#f4f1ea', '#e74c3c', '#3498db', '#f39c12', '#ecf0f1', '#9b59b6'];
          const n = Math.max(3, Math.round(s.w / 14));
          for (const z of [s.y + 2, s.y + s.h - 2, cz]) {
            for (let k = 0; k < n; k++) {
              const sh = new THREE.Mesh(new THREE.PlaneGeometry(s.w / n - 0.6, 30), new THREE.MeshLambertMaterial({ color: cols[(k + Math.round(z)) % cols.length], side: THREE.DoubleSide }));
              sh.position.set(s.x + (k + 0.5) * (s.w / n), 23, z);
              sh.castShadow = true;
              g.add(sh);
            }
          }
          // sheets across the short ends too, so it's a little tent of washing
          for (const x of [s.x + 1, s.x + s.w - 1]) {
            const sh = new THREE.Mesh(new THREE.PlaneGeometry(s.h - 4, 30), new THREE.MeshLambertMaterial({ color: '#ecf0f1', side: THREE.DoubleSide }));
            sh.rotation.y = Math.PI / 2;
            sh.position.set(x, 23, cz);
            g.add(sh);
          }
        }
        scene.add(g);
        this.spotGroups.push(g);
        const hit = new THREE.Mesh(new THREE.BoxGeometry(s.w, 40, s.h), hitMat);
        hit.position.set(cx, 20, cz);
        hit.userData.spot = i;
        scene.add(hit);
        this.spotHit.push(hit);
      });
    }

    // ---------------------------------------------------------- people
    buildPeople() {
      const N = (this.cap = 320);
      const lam = () => new THREE.MeshLambertMaterial({ color: '#ffffff' });
      const mk = (geo) => {
        const m = new THREE.InstancedMesh(geo, lam(), N);
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        m.castShadow = true;
        m.frustumCulled = false;
        m.count = 0;
        this.scene.add(m);
        return m;
      };
      this.parts = {
        legL: mk(new THREE.BoxGeometry(4.2, 14, 4.2).translate(0, -7, 0)),
        legR: mk(new THREE.BoxGeometry(4.2, 14, 4.2).translate(0, -7, 0)),
        torso: mk(new THREE.BoxGeometry(7, 13, 11.5)),
        armL: mk(new THREE.BoxGeometry(3.4, 11, 3.4).translate(0, -5.5, 0)),
        armR: mk(new THREE.BoxGeometry(3.4, 11, 3.4).translate(0, -5.5, 0)),
        head: mk(new THREE.SphereGeometry(4.8, 10, 8)),
      };
      // one hat mesh per look
      const hemi = (r) => new THREE.SphereGeometry(r, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);
      const hatGeo = {
        bucket: merge([new THREE.CylinderGeometry(4.6, 5.2, 4, 12).translate(0, 2, 0), new THREE.CylinderGeometry(8, 8, 0.8, 16)]),
        ivy: merge([new THREE.SphereGeometry(5.4, 12, 6).scale(1.15, 0.45, 1).translate(1.2, 0.6, 0), new THREE.CylinderGeometry(3, 3, 0.6, 10).scale(1, 1, 1.4).translate(5.4, 0, 0)]),
        beanie: merge([hemi(5.4).scale(1, 1.25, 1), new THREE.CylinderGeometry(5.5, 5.5, 2, 12).translate(0, 0.4, 0), new THREE.SphereGeometry(1.6, 6, 6).translate(0, 6.9, 0)]),
        doek: merge([hemi(5.6).scale(1.05, 1.5, 1.05), new THREE.SphereGeometry(2.6, 8, 6).translate(-5.2, 3, 0)]),
        cap: merge([hemi(5.2), new THREE.CylinderGeometry(4.2, 4.2, 0.7, 12).scale(1.3, 1, 1).translate(5.5, 0.3, 0)]),
      };
      this.hats = TFL.STYLES.map((S) => {
        const m = mk(hatGeo[S.hat]);
        m.material.color.set(S.hatColor);
        return m;
      });
      this.tmp = { m: new THREE.Matrix4(), b: new THREE.Matrix4(), l: new THREE.Matrix4(), r: new THREE.Matrix4(), q: new THREE.Quaternion(), e: new THREE.Euler(), v: new THREE.Vector3(), s: new THREE.Vector3(1, 1, 1), c: new THREE.Color() };
      this.zero = new THREE.Matrix4().makeScale(0, 0, 0);
    }

    // ---------------------------------------------------------- markers
    buildMarkers() {
      const mkRing = (inner, outer, color) => {
        const m = new THREE.Mesh(new THREE.RingGeometry(inner, outer, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false }));
        m.renderOrder = 5;
        m.visible = false;
        this.scene.add(m);
        return m;
      };
      const mkLabel = (text, color) => {
        const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: textTexture(text, color), depthTest: false, depthWrite: false }));
        s.scale.set(28, 7, 1);
        s.renderOrder = 10;
        s.visible = false;
        this.scene.add(s);
        return s;
      };
      this.ringPool = [];
      this.mkRing = mkRing;
      this.hoverRing = mkRing(12, 14.5, '#ffffff');
      this.targetRing = mkRing(14, 18, '#f1c40f');
      this.targetLabel = mkLabel('TARGET', '#f1c40f');
      this.hunterRings = [0, 1].map(() => mkRing(14, 18, '#e74c3c'));
      this.hunterLabels = [0, 1].map(() => mkLabel('HUNTER', '#e74c3c'));
      this.decoyLabel = mkLabel('YOUR DECOY', '#9b8cf0');
      this.hidingLabel = mkLabel('HIDING', '#7bd66b');
      this.spotBox = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: '#ffffff', wireframe: true, transparent: true, opacity: 0.8 }));
      this.spotBox.visible = false;
      this.scene.add(this.spotBox);
      this.dot = softDot();
      const starGeo = new THREE.SphereGeometry(1.4, 6, 6);
      this.stars = new THREE.InstancedMesh(starGeo, new THREE.MeshBasicMaterial({ color: '#ffe066' }), 60);
      this.stars.count = 0;
      this.stars.frustumCulled = false;
      this.scene.add(this.stars);
    }

    // ---------------------------------------------------------- camera
    placeCamera(cam) {
      const fx = Math.cos(cam.yaw), fz = Math.sin(cam.yaw);
      const rx = -fz, rz = fx;
      const tx = cam.x + rx * 22, tz = cam.y + rz * 22, ty = 34; // over the right shoulder
      let D = (cam.dist || 86) * (this.camera.aspect < 1 ? 1.35 : 1);
      const back = Math.cos(cam.pitch), up = Math.sin(cam.pitch);
      // pull the camera in when a building is in the way
      for (let d = 8; d < D; d += 5) {
        const px = tx - fx * d * back, pz = tz - fz * d * back, py = ty + up * d;
        let blocked = false;
        for (const [o, top] of this.obstacleTops) {
          if (py < top + 2 && px > o.x - 3 && px < o.x + o.w + 3 && pz > o.y - 3 && pz < o.y + o.h + 3) { blocked = true; break; }
        }
        if (blocked) { D = Math.max(10, d - 4); break; }
      }
      this.camera.position.set(tx - fx * D * back, Math.max(6, ty + up * D), tz - fz * D * back);
      // the crosshair (screen centre) rests on whoever is at arm's length in front of you
      this.camera.lookAt(cam.x + fx * 30 + rx * 11, 19, cam.y + fz * 30 + rz * 11);
      this.sun.position.set(cam.x - 260, 520, cam.y - 180);
      this.sun.target.position.set(cam.x, 0, cam.y);
    }

    // ---------------------------------------------------------- picking
    /** What's under this screen point: {spot} or {id}, nearest first. */
    pick(sx, sy, ents, meId, myPos) {
      const ndc = new THREE.Vector2((sx / this.vw) * 2 - 1, -(sy / this.vh) * 2 + 1);
      this.raycaster.setFromCamera(ndc, this.camera);
      const ray = this.raycaster.ray;
      let best = null, bestT = Infinity;
      const hits = this.raycaster.intersectObjects(this.spotHit, false);
      if (hits.length && hits[0].distance < 400) {
        const i = hits[0].object.userData.spot;
        best = { spot: i, inReach: TFL.spotDist(this.map.spots[i], myPos.x, myPos.y) < C.ACTION_RANGE - 6 };
        bestT = hits[0].distance;
      }
      // people: test the aim point against each body's on-screen silhouette
      const cam = this.camera, v = this.tmp.v;
      const toScreen = (x, y, z) => { v.set(x, y, z).project(cam); return { x: (v.x + 1) / 2 * this.vw, y: (1 - v.y) / 2 * this.vh, z: v.z }; };
      for (const e of ents) {
        if (e.id === meId || e.flags & 1 || e.covered) continue;
        const dx = e.x - cam.position.x, dz = e.y - cam.position.z;
        const depth = Math.hypot(dx, dz);
        if (depth > 420 || depth > bestT) continue;
        const top = toScreen(e.x, H_PERSON + 2, e.y), bot = toScreen(e.x, 0, e.y);
        if (top.z > 1 || bot.z > 1) continue; // behind the camera
        const hpx = bot.y - top.y, half = Math.max(7, hpx * 0.24);
        if (sx > top.x - half && sx < top.x + half && sy > top.y && sy < bot.y) {
          bestT = depth;
          best = { id: e.id, x: e.x, y: e.y, inReach: Math.hypot(e.x - myPos.x, e.y - myPos.y) < C.ACTION_RANGE + 6 };
        }
      }
      return best;
    }

    // ---------------------------------------------------------- frame
    draw(view) {
      this.placeCamera(view.cam);
      const P = this.parts, T = this.tmp;
      let n = 0;
      const hatCounts = this.hats.map(() => 0);
      let stars = 0;
      const byId = new Map();
      for (const e of view.ents) {
        byId.set(e.id, e);
        if (e.covered && e.id !== view.meId) continue; // hidden in a spot
        if (n >= this.cap) break;
        const S = TFL.STYLES[e.style];
        const down = e.flags & 1;
        const fall = down ? (e.fall === undefined ? 1 : e.fall) : 0;
        // body base: position, facing, and the collapse when taken out
        T.e.set(0, -e.facing, 0);
        T.q.setFromEuler(T.e);
        T.b.compose(T.v.set(e.x, fall * 3, e.y), T.q, T.s);
        if (fall > 0) T.b.multiply(T.l.makeRotationZ(-Math.PI / 2 * Math.min(1, fall * 1.3)));
        const swing = down ? 0 : Math.sin(e.phase) * 0.6;
        const strike = e.flags & 8;
        const put = (mesh, idx, local) => { T.m.multiplyMatrices(T.b, local); mesh.setMatrixAt(idx, T.m); };
        put(P.legL, n, T.l.makeTranslation(0, 14, -3.1).multiply(T.r.makeRotationZ(swing)));
        put(P.legR, n, T.l.makeTranslation(0, 14, 3.1).multiply(T.r.makeRotationZ(-swing)));
        put(P.torso, n, T.l.makeTranslation(0, 20.5, 0));
        put(P.armL, n, T.l.makeTranslation(0, 26, -7.4).multiply(T.r.makeRotationZ(-swing * 0.8)));
        put(P.armR, n, T.l.makeTranslation(0, 26, 7.4).multiply(T.r.makeRotationZ(strike ? 1.9 : swing * 0.8)));
        put(P.head, n, T.l.makeTranslation(0.5, 31.5, 0));
        const skin = TFL.SKINS[TFL.hash(e.id) % TFL.SKINS.length];
        P.legL.setColorAt(n, T.c.set(S.pants)); P.legR.setColorAt(n, T.c);
        P.torso.setColorAt(n, T.c.set(S.shirt));
        P.armL.setColorAt(n, T.c.set(skin)); P.armR.setColorAt(n, T.c); P.head.setColorAt(n, T.c);
        const hm = this.hats[e.style];
        put(hm, hatCounts[e.style]++, T.l.makeTranslation(0.5, 34, 0));
        if (e.flags & 2 && !down && stars < 57) {
          for (let k = 0; k < 3; k++) {
            const a = view.t * 4 + (k * Math.PI * 2) / 3;
            this.stars.setMatrixAt(stars++, T.m.makeTranslation(e.x + Math.cos(a) * 7, 42, e.y + Math.sin(a) * 7));
          }
        }
        n++;
      }
      for (const k in P) {
        P[k].count = n;
        P[k].instanceMatrix.needsUpdate = true;
        if (P[k].instanceColor) P[k].instanceColor.needsUpdate = true;
      }
      this.hats.forEach((h, i) => { h.count = hatCounts[i]; h.instanceMatrix.needsUpdate = true; });
      this.stars.count = stars;
      this.stars.instanceMatrix.needsUpdate = true;

      // markers
      const pulse = 0.5 + 0.5 * Math.sin(view.t * 6);
      const setRing = (ring, e, scale) => {
        ring.visible = !!e;
        if (e) { ring.position.set(e.x, 0.6, e.y); ring.scale.setScalar(scale || 1); }
      };
      const setLabel = (lab, e, y) => {
        lab.visible = !!e;
        if (e) lab.position.set(e.x, y || 50, e.y);
      };
      const tgt = view.targetId && byId.get(view.targetId);
      setRing(this.targetRing, tgt && !tgt.covered ? tgt : null, 1 + pulse * 0.15);
      setLabel(this.targetLabel, tgt && !tgt.covered ? tgt : null);
      const hunters = [...view.exposed].map((id) => byId.get(id)).filter(Boolean);
      this.hunterRings.forEach((r, i) => setRing(r, hunters[i], 1 + pulse * 0.15));
      this.hunterLabels.forEach((l, i) => setLabel(l, hunters[i]));
      const hov = view.hover && view.hover.id && byId.get(view.hover.id);
      setRing(this.hoverRing, hov || null);
      if (hov) {
        this.hoverRing.material.color.set(view.poisonArmed ? '#7bd66b' : '#ffffff');
        this.hoverRing.material.opacity = view.hover.inReach ? 0.95 : 0.35;
      }
      if (view.hover && view.hover.spot !== undefined) {
        const s = this.map.spots[view.hover.spot];
        this.spotBox.visible = true;
        this.spotBox.position.set(s.x + s.w / 2, 22, s.y + s.h / 2);
        this.spotBox.scale.set(s.w + 4, 44, s.h + 4);
        this.spotBox.material.color.set(view.poisonArmed ? '#7bd66b' : '#ffffff');
        this.spotBox.material.opacity = view.hover.inReach ? 0.85 : 0.3;
      } else this.spotBox.visible = false;
      const me = byId.get(view.meId);
      setLabel(this.hidingLabel, view.meSpot && me ? me : null, 54);

      // rustling hiding spots
      this.map.spots.forEach((s, i) => {
        let moving = false;
        for (const e of view.ents) if (e.covered && e.phase && e.x > s.x && e.x < s.x + s.w && e.y > s.y && e.y < s.y + s.h) { moving = true; break; }
        this.spotGroups[i].position.x = moving ? Math.sin(view.t * 30) * 1.2 : 0;
      });

      this.updateFx(view, byId);
      this.gl.render(this.scene, this.camera);
    }

    // ---------------------------------------------------------- effects
    spawn(x, y, z, color, size, vel, life, grow) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.dot, color, transparent: true, depthWrite: false }));
      s.position.set(x, y, z);
      s.scale.setScalar(size);
      this.scene.add(s);
      this.particles.push({ s, vel, life, age: 0, size, grow });
    }

    updateFx(view, byId) {
      const dt = Math.min(0.05, view.t - (this.lastT || view.t));
      this.lastT = view.t;
      let decoy = null;
      for (const f of view.fx || []) {
        if (f.k === 'decoy' && view.t - f.at < 2.5) decoy = byId.get(f.id);
        if (this.seenFx.has(f)) continue;
        this.seenFx.add(f);
        const r = Math.random;
        if (f.k === 'dust') {
          for (let i = 0; i < 18; i++) { const a = r() * 6.28; this.spawn(f.x, 6 + r() * 10, f.y, '#d9b886', 18, [Math.cos(a) * 50, 8 + r() * 10, Math.sin(a) * 50], 1.3, 40); }
        } else if (f.k === 'kill') {
          this.spawn(f.x, 22, f.y, '#ffffff', 30, [0, 0, 0], 0.25, 60);
          for (let i = 0; i < 16; i++) { const a = r() * 6.28; this.spawn(f.x, 22, f.y, i % 2 ? '#f1c40f' : '#c8281e', 4, [Math.cos(a) * 70, 30 + r() * 50, Math.sin(a) * 70], 0.8, 0); }
        } else if (f.k === 'poison') {
          for (let i = 0; i < 12; i++) this.spawn(f.x + (r() - 0.5) * 14, 10 + r() * 10, f.y + (r() - 0.5) * 14, '#6ec85a', 10, [0, 18 + r() * 12, 0], 1.4, 14);
        } else if (f.k === 'klap') {
          for (let i = 0; i < 10; i++) { const a = r() * 6.28; this.spawn(f.x, 32, f.y, '#ffe066', 5, [Math.cos(a) * 40, 20, Math.sin(a) * 40], 0.7, 0); }
        } else if (f.k === 'clone') {
          const ring = this.mkRing(0.9, 1, '#9b8cf0');
          ring.visible = true;
          ring.position.set(f.x, 1, f.y);
          this.particles.push({ ring, life: 1.2, age: 0, max: C.CLONE_RANGE });
        }
      }
      this.decoyLabel.visible = !!decoy;
      if (decoy) this.decoyLabel.position.set(decoy.x, 50, decoy.y);
      this.particles = this.particles.filter((p) => {
        p.age += dt;
        const k = p.age / p.life;
        if (k >= 1) {
          const o = p.s || p.ring;
          this.scene.remove(o);
          o.material.dispose();
          if (p.ring) o.geometry.dispose();
          return false;
        }
        if (p.ring) {
          p.ring.scale.setScalar(Math.max(1, p.max * k));
          p.ring.material.opacity = 1 - k;
          return true;
        }
        p.s.position.x += p.vel[0] * dt;
        p.s.position.y = Math.max(1, p.s.position.y + p.vel[1] * dt);
        p.s.position.z += p.vel[2] * dt;
        p.vel[1] -= p.grow ? 0 : 120 * dt;
        p.s.scale.setScalar(p.size + p.grow * k);
        p.s.material.opacity = 1 - k;
        return true;
      });
    }

    dispose() {
      this.gl.dispose();
    }
  }

  TFL.Renderer3D = Renderer3D;
})();
