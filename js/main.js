/* Tsotsi's For Life — menus, lobby and session glue. */
(function () {
  'use strict';
  const TFL = window.TFL;
  const C = TFL.C;
  const $ = (id) => document.getElementById(id);

  function cleanName(s) {
    s = String(s || '').replace(/[^\p{L}\p{N} _.'-]/gu, '').trim().slice(0, 14);
    return s || 'Tsotsi';
  }

  function show(screen) {
    for (const id of ['menu', 'lobby', 'end']) $(id).hidden = id !== screen;
  }

  function setError(msg) {
    $('menuError').textContent = msg || '';
  }

  // ------------------------------------------------------------ the host
  class HostSession {
    constructor(app, name) {
      this.app = app;
      this.players = [{ pid: 'host', name: cleanName(name), style: 0 }];
      this.pending = new Map(); // connected but no hello yet
      this.lastSeen = new Map();
      this.state = 'lobby';
      this.duration = 300;
      this.game = null;
    }

    async open() {
      this.net = await TFL.net.host({
        onConnect: (pid) => { this.pending.set(pid, Date.now()); this.lastSeen.set(pid, Date.now()); },
        onMessage: (pid, msg) => this.handle(pid, msg),
        onDisconnect: (pid) => this.drop(pid),
        onError: (e) => console.warn('[host]', e),
      });
      this.code = this.net.code;
      this.watchdog = setInterval(() => this.checkTimeouts(), 2000);
      this.pushLobby();
    }

    checkTimeouts() {
      const now = Date.now();
      for (const [pid, at] of this.pending) {
        if (now - at > 8000) { this.pending.delete(pid); this.net.kick(pid); }
      }
      for (const p of this.players) {
        if (p.pid === 'host' || p.bot) continue;
        if (now - (this.lastSeen.get(p.pid) || 0) > 10000) { this.net.kick(p.pid); this.drop(p.pid); }
      }
      if (this.state !== 'playing') this.pushLobby(); // doubles as a keep-alive
    }

    handle(pid, msg) {
      if (!msg || typeof msg !== 'object') return;
      this.lastSeen.set(pid, Date.now());
      if (msg.t === 'hello' && pid !== 'host') {
        if (!this.pending.has(pid)) return;
        this.pending.delete(pid);
        if (this.state !== 'lobby') return this.reject(pid, 'That game has already started. Wait for the next round.');
        if (this.players.length >= C.MAX_PLAYERS) return this.reject(pid, 'That room is full (' + C.MAX_PLAYERS + ' players max).');
        let name = cleanName(msg.name);
        const taken = new Set(this.players.map((p) => p.name.toLowerCase()));
        for (let n = 2; taken.has(name.toLowerCase()); n++) name = cleanName(msg.name).slice(0, 12) + ' ' + n;
        const used = new Set(this.players.map((p) => p.style));
        let style = 0;
        while (used.has(style)) style++;
        this.players.push({ pid, name, style });
        this.pushLobby();
        return;
      }
      if (!this.players.some((p) => p.pid === pid)) return;
      if ((msg.t === 'in' || msg.t === 'act' || msg.t === 'ab') && this.game) this.game.handle(pid, msg);
      else if (msg.t === 'leave') this.drop(pid);
    }

    reject(pid, reason) {
      this.net.send(pid, { t: 'reject', reason });
      this.net.kick(pid);
    }

    drop(pid) {
      this.pending.delete(pid);
      this.lastSeen.delete(pid);
      const before = this.players.length;
      this.players = this.players.filter((p) => p.pid !== pid);
      if (this.players.length === before) return;
      if (this.game) this.game.removePlayer(pid);
      if (this.state !== 'playing') this.pushLobby();
    }

    addBot() {
      if (this.state !== 'lobby' || this.players.length >= C.MAX_PLAYERS) return;
      const names = ['Bra Tebza', 'Mampho', 'Lucky', 'Zola', 'Ntombi', 'Jabu', 'Kea', 'Spha'];
      const taken = new Set(this.players.map((p) => p.name));
      const name = (names.find((n) => !taken.has(n + ' [bot]')) || 'Bot') + ' [bot]';
      const used = new Set(this.players.map((p) => p.style));
      let style = 0;
      while (used.has(style)) style++;
      this.botSeq = (this.botSeq || 0) + 1;
      this.players.push({ pid: 'bot' + this.botSeq, name, style, bot: true });
      this.pushLobby();
    }

    removeBot(pid) {
      if (this.state !== 'lobby') return;
      this.players = this.players.filter((p) => !(p.bot && p.pid === pid));
      this.pushLobby();
    }

    sendTo(pid, msg) {
      if (pid.startsWith('bot')) return;
      if (pid === 'host') this.app.onMessage(msg);
      else this.net.send(pid, msg);
    }

    pushLobby() {
      const list = this.players.map((p) => ({ name: p.name, style: p.style, host: p.pid === 'host', bot: p.bot ? p.pid : null }));
      for (const p of this.players) {
        this.sendTo(p.pid, { t: 'lobby', state: this.state, code: this.code, players: list, me: p.style, duration: this.duration });
      }
    }

    setDuration(sec) {
      this.duration = sec;
      this.pushLobby();
    }

    start() {
      if (this.players.length < C.MIN_PLAYERS || this.players.length > C.MAX_PLAYERS) return;
      if (this.state === 'playing') return;
      this.state = 'playing';
      const seed = Math.floor(Math.random() * 2 ** 31);
      const roster = this.players.map((p) => ({ name: p.name, style: p.style }));
      for (const p of this.players) this.sendTo(p.pid, { t: 'start', seed, duration: this.duration, roster });
      this.game = new TFL.HostGame({
        players: this.players,
        seed,
        duration: this.duration,
        send: (pid, msg) => this.sendTo(pid, msg),
        onEnd: (results) => this.end(results),
      });
      let last = performance.now();
      this.ticker = TFL.makeTicker(C.TICK_MS, () => {
        const now = performance.now();
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        if (this.game) this.game.tick(dt);
      });
    }

    end(results) {
      if (this.ticker) this.ticker.stop();
      this.ticker = null;
      this.state = 'ended';
      for (const p of this.players) this.sendTo(p.pid, { t: 'end', results });
      // game.finish() can fire from inside tick; drop the reference afterwards
      setTimeout(() => { this.game = null; }, 0);
    }

    backToLobby() {
      this.state = 'lobby';
      this.pushLobby();
    }

    close() {
      clearInterval(this.watchdog);
      if (this.ticker) this.ticker.stop();
      for (const p of this.players) if (p.pid !== 'host') this.net.send(p.pid, { t: 'closed' });
      setTimeout(() => this.net && this.net.close(), 150);
    }
  }

  // --------------------------------------------------------------- app
  const App = {
    role: null,
    host: null,
    link: null,
    client: null,
    lastFromHost: 0,

    send(msg) {
      if (this.role === 'host') this.host.handle('host', msg);
      else if (this.link) this.link.send(msg);
    },

    onMessage(m) {
      this.lastFromHost = Date.now();
      switch (m.t) {
        case 'lobby':
          if (m.state === 'lobby') {
            this.stopGame();
            this.renderLobby(m);
          }
          break;
        case 'start':
          show(null);
          this.stopGame();
          TFL.client = this.client = new TFL.GameClient(m, (msg) => this.send(msg));
          break;
        case 's':
        case 'ev':
          if (this.client) this.client.onMessage(m);
          break;
        case 'end':
          this.stopGame();
          this.renderEnd(m.results);
          break;
        case 'reject':
          this.leave(m.reason);
          break;
        case 'closed':
          this.leave('The host closed the room.');
          break;
      }
    },

    stopGame() {
      if (this.client) this.client.destroy();
      this.client = TFL.client = null;
    },

    async hostGame() {
      setError('');
      const name = $('nameInput').value;
      saveName(name);
      $('btnHost').disabled = true;
      $('btnHost').textContent = 'Opening room…';
      try {
        this.role = 'host';
        this.host = new HostSession(this, name);
        await this.host.open();
      } catch (e) {
        this.role = null;
        this.host = null;
        setError(e.message || String(e));
      } finally {
        $('btnHost').disabled = false;
        $('btnHost').textContent = 'Host a game';
      }
    },

    async joinGame() {
      setError('');
      const code = $('codeInput').value.trim().toUpperCase();
      if (!/^[A-Z]{4}$/.test(code)) return setError('Room codes are 4 letters.');
      const name = $('nameInput').value;
      saveName(name);
      $('btnJoin').disabled = true;
      $('btnJoin').textContent = 'Connecting…';
      try {
        this.role = 'client';
        this.link = await TFL.net.join(code, {
          onMessage: (m) => this.onMessage(m),
          onClose: () => this.leave('Lost connection to the host.'),
        });
        this.lastFromHost = Date.now();
        this.link.send({ t: 'hello', name });
        this.ping = setInterval(() => {
          if (!this.client) this.send({ t: 'ping' });
          if (Date.now() - this.lastFromHost > 12000) this.leave('The host stopped responding.');
        }, 2000);
      } catch (e) {
        this.role = null;
        setError(e.message || String(e));
      } finally {
        $('btnJoin').disabled = false;
        $('btnJoin').textContent = 'Join';
      }
    },

    leave(reason) {
      clearInterval(this.ping);
      this.stopGame();
      if (this.role === 'host' && this.host) this.host.close();
      else if (this.link) { this.send({ t: 'leave' }); const l = this.link; setTimeout(() => l.close(), 100); }
      this.role = null;
      this.host = null;
      this.link = null;
      show('menu');
      setError(reason || '');
    },

    renderLobby(m) {
      show('lobby');
      const isHost = this.role === 'host';
      $('roomCode').textContent = m.code;
      const url = new URL(location.href);
      url.searchParams.set('room', m.code);
      $('roomLink').value = url.toString();
      const list = $('playerList');
      list.innerHTML = '';
      for (let i = 0; i < C.MAX_PLAYERS; i++) {
        const p = m.players[i];
        const row = document.createElement('div');
        row.className = 'slot' + (p ? '' : ' open') + (p && p.style === m.me ? ' you' : '');
        if (p) {
          const cv = document.createElement('canvas');
          cv.width = cv.height = 56;
          TFL.drawPortrait(cv, p.style);
          row.appendChild(cv);
          const info = document.createElement('div');
          info.className = 'slot-info';
          info.innerHTML = `<div class="slot-name">${TFL.esc(p.name.replace(' [bot]', ''))}${p.bot ? ' <span class="tag bot">BOT</span>' : ''}${p.host ? ' <span class="tag">HOST</span>' : ''}${p.style === m.me ? ' <span class="tag you">YOU</span>' : ''}</div><div class="slot-look">${TFL.STYLES[p.style].name}</div>`;
          row.appendChild(info);
          if (p.bot && isHost) {
            const x = document.createElement('button');
            x.className = 'btn ghost small slot-x';
            x.textContent = 'Remove';
            x.onclick = () => this.host.removeBot(p.bot);
            row.appendChild(x);
          }
        } else {
          row.innerHTML = `<div class="slot-empty">${i < C.MIN_PLAYERS ? 'Waiting for a player…' : 'Open slot'}</div>`;
        }
        list.appendChild(row);
      }
      const n = m.players.length;
      const ready = n >= C.MIN_PLAYERS;
      $('lobbyHint').textContent = ready ? n + ' tsotsis in the room. ' + (isHost ? 'Start when everyone is in.' : 'Waiting for the host to start…') : 'Need at least ' + C.MIN_PLAYERS + ' players — ' + (C.MIN_PLAYERS - n) + ' more to go.';
      $('btnStart').hidden = !isHost;
      $('btnBot').hidden = !isHost;
      $('btnBot').disabled = n >= C.MAX_PLAYERS;
      $('btnStart').disabled = !ready;
      $('durationSel').disabled = !isHost;
      $('durationSel').value = String(m.duration);
    },

    renderEnd(results) {
      show('end');
      const isHost = this.role === 'host';
      const tbody = $('resultsBody');
      tbody.innerHTML = results.map((r, i) => `<tr class="${i === 0 ? 'winner' : ''}"><td>${i + 1}</td><td><span class="sb-dot" style="background:${TFL.STYLES[r.style].shirt}"></span>${TFL.esc(r.name)}</td><td>${r.kills}</td><td>${r.stuns}</td><td>${r.deaths}</td><td class="pts">${r.score}</td></tr>`).join('');
      $('winnerName').textContent = results.length ? results[0].name : '—';
      $('btnAgain').hidden = !isHost;
      $('endHint').textContent = isHost ? '' : 'Waiting for the host to start another round…';
    },
  };

  function saveName(n) {
    try { localStorage.setItem('tfl-name', cleanName(n)); } catch (e) { /* private mode */ }
  }

  function init() {
    try { $('nameInput').value = localStorage.getItem('tfl-name') || ''; } catch (e) { /* ignore */ }
    const room = new URLSearchParams(location.search).get('room');
    if (room) $('codeInput').value = room.toUpperCase().slice(0, 4);
    if (TFL.net.mode === 'local') $('modeBadge').hidden = false;

    $('btnHost').onclick = () => App.hostGame();
    $('btnJoin').onclick = () => App.joinGame();
    $('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') App.joinGame(); });
    $('codeInput').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, ''); });
    $('btnBot').onclick = () => App.host && App.host.addBot();
    $('btnStart').onclick = () => App.host && App.host.start();
    $('btnLeave').onclick = () => App.leave('');
    $('btnEndLeave').onclick = () => App.leave('');
    $('btnAgain').onclick = () => App.host && App.host.backToLobby();
    $('durationSel').onchange = (e) => App.host && App.host.setDuration(+e.target.value);
    $('btnCopy').onclick = () => {
      const v = $('roomLink').value;
      (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject()).then(
        () => { $('btnCopy').textContent = 'Copied!'; setTimeout(() => ($('btnCopy').textContent = 'Copy invite link'), 1500); },
        () => { $('roomLink').select(); document.execCommand('copy'); }
      );
    };
    $('btnQuit').onclick = () => { if (confirm('Leave this game?')) App.leave(''); };
    window.addEventListener('pagehide', () => { if (App.role) App.leave(''); });
    show('menu');
  }

  TFL.App = App;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
