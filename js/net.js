/* Tsotsi's For Life — transports.
 *
 * "peer"  : WebRTC data channels via PeerJS. The public PeerJS broker is used
 *           only to introduce peers; all game traffic flows directly between
 *           browsers. Topology is a star around the room's host peer.
 * "local" : BroadcastChannel between tabs of the same browser. For testing
 *           on one machine without any network (add ?local to the URL).
 *
 * Host API:   { code, send(pid, msg), kick(pid), close() }
 * Client API: { send(msg), close() }
 */
(function () {
  'use strict';
  const TFL = window.TFL;
  const PREFIX = 'tsotsis4life-v1-';
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

  function makeCode() {
    let s = '';
    for (let i = 0; i < 4; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return s;
  }

  function friendlyError(err) {
    const t = err && err.type;
    if (t === 'peer-unavailable') return 'No room with that code. Check the code and try again.';
    if (t === 'network' || t === 'server-error' || t === 'socket-error' || t === 'socket-closed') return 'Could not reach the matchmaking server. Check your internet connection.';
    if (t === 'browser-incompatible') return 'This browser does not support WebRTC.';
    if (t === 'unavailable-id') return 'That room code is taken.';
    return (err && err.message) || String(err);
  }

  // ---------------------------------------------------------------- PeerJS
  function hostPeer(handlers) {
    return new Promise((resolve, reject) => {
      if (!window.Peer) return reject(new Error('PeerJS failed to load.'));
      let attempts = 0;
      const tryCode = () => {
        const code = makeCode();
        const peer = new window.Peer(PREFIX + code, { debug: 1 });
        const conns = new Map();
        let opened = false, seq = 0;
        const api = {
          code,
          send(pid, msg) {
            const c = conns.get(pid);
            if (c && c.open) {
              try { c.send(msg); } catch (e) { /* channel closing */ }
            }
          },
          kick(pid) {
            const c = conns.get(pid);
            conns.delete(pid);
            if (c) setTimeout(() => c.close(), 200);
          },
          close() { peer.destroy(); },
        };
        peer.on('open', () => { opened = true; resolve(api); });
        peer.on('error', (err) => {
          if (!opened) {
            peer.destroy();
            if (err.type === 'unavailable-id' && ++attempts < 5) return tryCode();
            return reject(new Error(friendlyError(err)));
          }
          if (handlers.onError) handlers.onError(friendlyError(err));
        });
        // Losing the broker does not affect running games; reconnect quietly
        // so new players can still join.
        peer.on('disconnected', () => { if (!peer.destroyed) setTimeout(() => !peer.destroyed && peer.reconnect(), 1000); });
        peer.on('connection', (conn) => {
          const pid = 'p' + ++seq;
          let gone = false;
          const drop = () => {
            if (gone) return;
            gone = true;
            if (conns.get(pid) === conn) conns.delete(pid);
            handlers.onDisconnect(pid);
          };
          conn.on('open', () => { conns.set(pid, conn); handlers.onConnect(pid); });
          conn.on('data', (d) => handlers.onMessage(pid, d));
          conn.on('close', drop);
          conn.on('error', drop);
        });
      };
      tryCode();
    });
  }

  function joinPeer(code, handlers) {
    return new Promise((resolve, reject) => {
      if (!window.Peer) return reject(new Error('PeerJS failed to load.'));
      const peer = new window.Peer({ debug: 1 });
      let opened = false, closed = false;
      const timer = setTimeout(() => {
        if (!opened) { peer.destroy(); reject(new Error('Timed out connecting to the host. Are you both online?')); }
      }, 15000);
      peer.on('error', (err) => {
        if (!opened) { clearTimeout(timer); peer.destroy(); reject(new Error(friendlyError(err))); }
      });
      peer.on('open', () => {
        const conn = peer.connect(PREFIX + code.toUpperCase(), { reliable: true, serialization: 'json' });
        const api = {
          send(msg) { if (conn.open) { try { conn.send(msg); } catch (e) { /* closing */ } } },
          close() { closed = true; peer.destroy(); },
        };
        conn.on('open', () => { opened = true; clearTimeout(timer); resolve(api); });
        conn.on('data', (d) => handlers.onMessage(d));
        const end = () => { if (opened && !closed) { closed = true; handlers.onClose(); } };
        conn.on('close', end);
        conn.on('error', end);
      });
    });
  }

  // ------------------------------------------------------ BroadcastChannel
  function hostLocal(handlers) {
    const code = makeCode();
    const bc = new BroadcastChannel('tfl-' + code);
    const known = new Set();
    bc.onmessage = (e) => {
      const m = e.data;
      if (m.to !== 'host') return;
      if (m.kind === 'join') {
        known.add(m.from);
        bc.postMessage({ to: m.from, kind: 'welcome' });
        handlers.onConnect(m.from);
      } else if (m.kind === 'msg' && known.has(m.from)) {
        handlers.onMessage(m.from, m.data);
      } else if (m.kind === 'leave' && known.delete(m.from)) {
        handlers.onDisconnect(m.from);
      }
    };
    return Promise.resolve({
      code,
      send(pid, msg) { if (known.has(pid)) bc.postMessage({ to: pid, kind: 'msg', data: msg }); },
      kick(pid) { known.delete(pid); setTimeout(() => bc.postMessage({ to: pid, kind: 'bye' }), 200); },
      close() { for (const pid of known) bc.postMessage({ to: pid, kind: 'bye' }); bc.close(); },
    });
  }

  function joinLocal(code, handlers) {
    return new Promise((resolve, reject) => {
      const id = 'L' + Math.random().toString(36).slice(2, 10);
      const bc = new BroadcastChannel('tfl-' + code.toUpperCase());
      let opened = false, closed = false;
      const api = {
        send(msg) { if (!closed) bc.postMessage({ to: 'host', from: id, kind: 'msg', data: msg }); },
        close() {
          if (closed) return;
          closed = true;
          bc.postMessage({ to: 'host', from: id, kind: 'leave' });
          bc.close();
        },
      };
      const timer = setTimeout(() => { if (!opened) { bc.close(); reject(new Error('No room with that code (local mode).')); } }, 2500);
      bc.onmessage = (e) => {
        const m = e.data;
        if (m.to !== id) return;
        if (m.kind === 'welcome') { opened = true; clearTimeout(timer); resolve(api); }
        else if (m.kind === 'msg') handlers.onMessage(m.data);
        else if (m.kind === 'bye' && !closed) { closed = true; bc.close(); handlers.onClose(); }
      };
      window.addEventListener('pagehide', () => api.close());
      bc.postMessage({ to: 'host', from: id, kind: 'join' });
    });
  }

  TFL.net = {
    mode: /[?&]local\b/.test(location.search) ? 'local' : 'peer',
    host(handlers) { return this.mode === 'local' ? hostLocal(handlers) : hostPeer(handlers); },
    join(code, handlers) { return this.mode === 'local' ? joinLocal(code, handlers) : joinPeer(code, handlers); },
  };
})();
