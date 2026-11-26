/* vpn.js - embedded anonymity / geo-unblock core (desktop)
   ----------------------------------------------------------------------------
   This module owns the SuperBox Shield: a real, anonymous Cloudflare WARP
   tunnel created by the open-source usque client (MASQUE / Connect-IP).
   No external VPN application is used and no account or license key is
   required: usque registers a throw-away WARP identity on first run.

   Responsibilities:
     - download-free provisioning (usque.exe is bundled with the app)
     - hidden child process, never a console window
     - HTTP proxy on 127.0.0.1:46950, consumed by srv2.js (undici) and by
       Electron's session proxy for every renderer request
     - endpoint failover on start: several MASQUE anchors are tried before
       the Shield is allowed to report a failure
     - a watchdog that notices a dead tunnel and repairs it in the background
     - region profiles: the routing engine rewrites the Cloudflare endpoint
       and reconnects when a source asks for another region, then reports the
       real egress country from the WARP trace endpoint
     - honest progress: phase + percentage for the gate UI
     - kill-switch semantics: while the proxy is down every upstream request
       fails closed instead of leaking around the tunnel
   --------------------------------------------------------------------------- */
'use strict';

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { app } = require('electron');
const { ProxyAgent, fetch: proxyFetch, setGlobalDispatcher, Agent } = require('undici');
const relay = require('./relay');

const PROXY_HOST = '127.0.0.1';
const PROXY_PORT = 46950;
const PROXY_URL = 'http://' + PROXY_HOST + ':' + PROXY_PORT;
const TRACE_URL = 'https://www.cloudflare.com/cdn-cgi/trace';
/* Captured before installDispatcher() swaps globalThis.fetch, so a manual
   "VPN OFF" can send every request straight out of the host connection. */
const BASE_FETCH = globalThis.fetch.bind(globalThis);

/* Public Cloudflare WARP MASQUE endpoints. Only the `.2`/`.3` addresses in
   these anycast ranges speak MASQUE over TLS/443; the older `.1` addresses
   are WireGuard-only and make usque fail its TLS handshake. Cloudflare does
   not sell or document per-country endpoints, so region profiles are
   best-effort: the router tries each endpoint in the profile, reads the real
   egress country from the trace response and keeps the closest match. The
   status object always reports the truth (requested region + actual egress).
   Every region ships 12 endpoint profiles for redundancy; the order is
   rotated so regions do not all hammer the same first address. */
const WARP_ENDPOINTS = [
  '162.159.198.2', '162.159.199.2',
  '162.159.192.2', '162.159.193.2', '162.159.195.2',
  '188.114.96.2', '188.114.97.2', '188.114.98.2', '188.114.99.2',
  '162.159.198.3', '162.159.199.3', '188.114.96.3'
];
/* Every region ships the full 12-endpoint pool. The first two addresses are
   the documented MASQUE anchors and stay first everywhere so a switch is fast;
   the rest are failover candidates. Cloudflare is anycast, so the pool cannot
   pin a country — `actual` always reports the measured egress. */
function pool() { return WARP_ENDPOINTS.slice(); }
const REGION_ENDPOINTS = {
  auto: pool(), us: pool(), ca: pool(), uk: pool(),
  au: pool(), in: pool(), de: pool(), jp: pool(),
  sg: pool(), hk: pool(), kr: pool(), fr: pool(), br: pool()
};
const REGION_LABEL = {
  auto: 'Global', us: 'United States', ca: 'Canada', uk: 'United Kingdom',
  au: 'Australia', in: 'India', de: 'Germany', jp: 'Japan',
  sg: 'Singapore', hk: 'Hong Kong', kr: 'South Korea', fr: 'France', br: 'Brazil'
};
/* Cloudflare's trace reports an edge airport code (colo). Translate the ones
   the regional profiles usually land on into a city for the live panel. */
const COLO_CITY = {
  BOM: 'Mumbai', DEL: 'New Delhi', MAA: 'Chennai', BLR: 'Bengaluru',
  IAD: 'Ashburn', EWR: 'Newark', LAX: 'Los Angeles', SJC: 'San Jose',
  ORD: 'Chicago', DFW: 'Dallas', MIA: 'Miami', SEA: 'Seattle',
  ATL: 'Atlanta', DEN: 'Denver', PHX: 'Phoenix', BOS: 'Boston',
  YYZ: 'Toronto', YVR: 'Vancouver', YUL: 'Montreal',
  LHR: 'London', LGW: 'London', MAN: 'Manchester',
  SYD: 'Sydney', MEL: 'Melbourne', BNE: 'Brisbane',
  FRA: 'Frankfurt', MUC: 'Munich', DUS: 'Düsseldorf',
  NRT: 'Tokyo', KIX: 'Osaka', SIN: 'Singapore', HKG: 'Hong Kong',
  ICN: 'Seoul', CDG: 'Paris', MRS: 'Marseille', GRU: 'São Paulo',
  AMS: 'Amsterdam', MAD: 'Madrid', FCO: 'Rome', WAW: 'Warsaw'
};

const START_ATTEMPTS = 6;        /* endpoint profiles tried on a cold start */
const ATTEMPT_READY_MS = 13000;  /* per-endpoint tunnel budget */
/* MASQUE over IPv6 is a different anycast path and, on networks where the
   IPv4 anchors are throttled to a few KB/s, it is often an order of magnitude
   faster. It is tried first with a shorter budget, then the IPv4 ladder. */
const WARP_ENDPOINT_V6 = '2606:4700:103::2';
const V6_READY_MS = 10000;
const WATCHDOG_MS = 20000;       /* health probe cadence while connected */
const WATCHDOG_FAILS = 3;        /* consecutive misses before self-repair */

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function normRegion(r) {
  var v = String(r || 'auto').toLowerCase();
  if (v === 'gb' || v === 'eng' || v === 'uk') return 'uk';
  if (v === 'usa' || v === 'us') return 'us';
  if (v === 'ca' || v === 'can') return 'ca';
  if (v === 'au' || v === 'aus') return 'au';
  if (v === 'in' || v === 'ind') return 'in';
  if (v === 'de' || v === 'ger') return 'de';
  if (v === 'jp' || v === 'jpn') return 'jp';
  if (v === 'sg' || v === 'sgp' || v === 'singapore') return 'sg';
  if (v === 'hk' || v === 'hkg' || v === 'hongkong') return 'hk';
  if (v === 'kr' || v === 'kor' || v === 'korea') return 'kr';
  if (v === 'fr' || v === 'fra') return 'fr';
  if (v === 'br' || v === 'bra') return 'br';
  return REGION_ENDPOINTS[v] ? v : 'auto';
}

class VpnManager {
  constructor() {
    this.child = null;
    this.state = 'idle';          /* idle | provisioning | connecting | on | error | off */
    this.enabled = true;          /* manual OFF clears this until the user re-enables */
    this.ping = 0;
    this.region = 'auto';
    this.preferred = 'auto';      /* region a source asked for; applied on reconnect */
    this.actual = '';
    this.colo = '';
    this.city = '';
    this.ip = '';
    this.warp = false;
    this.error = '';
    this.startedAt = 0;
    this.lastProbe = 0;
    this.probing = null;
    this.progress = 0;
    this.phase = 'idle';
    this.attempt = 0;
    this.endpoint = '';
    this.transport = 'ipv4';
    this.dnsMode = 'cf';
    this._starting = null;
    this._recovering = null;
    this._dispatcherInstalled = false;
    this._agent = null;
    this._watchdog = null;
    this._watchFails = 0;
    this._watchBusy = false;
    this.mode = 'warp';           /* warp | relay */
    this.relay = null;            /* verified regional exit descriptor */
    this._relayAgent = null;      /* undici dispatcher for the active exit */
    this._relayBusy = null;
    try { relay.configure({ cacheFile: path.join(this.dataDir(), 'relays.json') }); } catch (e) {}
  }

  binary() {
    var candidates = [];
    try { candidates.push(path.join(process.resourcesPath, 'bin', 'usque.exe')); } catch (e) {}
    candidates.push(path.join(__dirname, 'bin', 'usque.exe'));
    candidates.push(path.join(__dirname, '..', 'tools', 'vpn', 'usque.exe'));
    for (var i = 0; i < candidates.length; i++) {
      try { if (fs.existsSync(candidates[i])) return candidates[i]; } catch (e) {}
    }
    return '';
  }

  dataDir() {
    var dir;
    try { dir = path.join(app.getPath('userData'), 'vpn'); }
    catch (e) { dir = path.join(process.env.APPDATA || process.env.LOCALAPPDATA || '.', 'SuperBox', 'vpn'); }
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    return dir;
  }

  configPath() { return path.join(this.dataDir(), 'config.json'); }

  agent() {
    if (this.mode === 'relay' && this._relayAgent) return this._relayAgent;
    if (!this._agent) {
      try {
        this._agent = new ProxyAgent({
          uri: PROXY_URL,
          keepAliveTimeout: 10000,
          keepAliveMaxTimeout: 30000,
          connectTimeout: 10000
        });
      } catch (e) {
        this._agent = new ProxyAgent(PROXY_URL);
      }
    }
    return this._agent;
  }

  /* Honest host routing for manual OFF. The global undici dispatcher stays
     pointed at the Shield while the app runs, so a direct request must opt out
     explicitly instead of inheriting the dead proxy. */
  directAgent() {
    if (!this._directAgent) {
      try { this._directAgent = new Agent({ connect: { timeout: 20000 } }); }
      catch (e) { this._directAgent = null; }
    }
    return this._directAgent;
  }

  /* Drop the regional exit and return the dispatcher to the WARP tunnel. The
     usque child is deliberately left running: switching back to
     "Fastest / Local Shield" is then instant, and the relay never has to
     rebuild the tunnel it may need as a fallback. */
  _clearRelay() {
    var old = this._relayAgent;
    this._relayAgent = null;
    this.relay = null;
    this.mode = 'warp';
    if (old) { try { old.close(); } catch (e) {} }
  }

  /* Pin a country by finding a relay that actually exits there. The relay is
     verified through Cloudflare's trace endpoint before it is installed, so
     the chip can never claim a country the traffic is not using. */
  async _activateRelay(region) {
    if (!this.enabled) return this.status();
    if (this._relayBusy) {
      /* A scan is already running. Let it settle, then honour the newest
         request instead of silently keeping the older country. */
      var selfQueue = this;
      return this._relayBusy.then(function () {
        return selfQueue._activateRelay(region);
      }, function () {
        return selfQueue._activateRelay(region);
      });
    }
    var self = this;
    var wanted = normRegion(region);
    this.preferred = wanted;
    this._relayBusy = (async function () {
      self.stopWatchdog();
      self.setPhase('connecting', 'Finding a live ' + (REGION_LABEL[wanted] || wanted) + ' exit', 8);
      self.error = '';
      try {
        var exit = await relay.findExit(wanted, {
          timeout: 70000,
          onProgress: function (done, total, msg) {
            var pct = 10 + Math.min(80, Math.round((done / Math.max(1, total)) * 80));
            self.setPhase('connecting', msg, pct);
          }
        });
        /* Manual OFF or a newer switch can land while the scan is running.
           Never install an exit the user has already cancelled. */
        if (!self.enabled || self.state === 'off') return self.status();
        if (self.preferred !== wanted) return self.status();
        var agent = relay.dispatcherFor(exit);
        var old = self._relayAgent;
        self._relayAgent = agent;
        self.relay = exit;
        self.mode = 'relay';
        self.region = wanted;
        self.preferred = wanted;
        self.warp = false;
        self.actual = exit.loc;
        self.colo = exit.colo || '';
        self.city = exit.city || '';
        self.ip = exit.ip || exit.host;
        self.endpoint = exit.host + ':' + exit.port;
        self.transport = exit.protocol;
        self.ping = 0;
        self.error = '';
        self.state = 'on';
        self.progress = 100;
        self.phase = 'Exit live';
        self.startedAt = Date.now();
        self.lastProbe = Date.now();
        self._watchFails = 0;
        try { setGlobalDispatcher(agent); } catch (e) {}
        if (old) { try { old.close(); } catch (e) {} }
        self.startWatchdog();
        self.notify();
        self.log('relay live ' + exit.url + ' egress=' + exit.loc + ' ' + (exit.city || ''));
        return self.status();
      } catch (e) {
        self.log('relay failed for ' + wanted + ': ' + (e && e.message));
        var reason = (e && e.message) || ('No live ' + wanted + ' exit');
        self.mode = 'warp';
        self.relay = null;
        if (self.child && self.state === 'on') {
          /* WARP is healthy; keep the app online and report the mismatch. */
          try { setGlobalDispatcher(self.agent()); } catch (err) {}
          self.phase = 'WARP fallback';
          self.error = reason;
          self.notify();
          return self.status();
        }
        try {
          await self._bringUp('auto', true);
          self.error = reason + ' \u00b7 using WARP ' + (self.actual || '');
        } catch (e2) {
          self.state = 'error';
          self.phase = 'No exit answered';
          self.error = reason;
        }
        self.notify();
        return self.status();
      } finally {
        self._relayBusy = null;
      }
    })();
    return this._relayBusy;
  }

  log(line) {
    try {
      var file = path.join(this.dataDir(), 'shield.log');
      fs.appendFileSync(file, '[' + new Date().toISOString() + '] ' + line + '\n');
      var st = fs.statSync(file);
      if (st.size > 512 * 1024) {
        try {
          var old = file + '.1';
          if (fs.existsSync(old)) fs.unlinkSync(old);
          fs.renameSync(file, old);
        } catch (e) {}
      }
    } catch (e) {}
    try { if (global.__superboxLog) global.__superboxLog('VPN', line); } catch (e) {}
  }

  setPhase(state, phase, progress) {
    if (state) this.state = state;
    if (phase) this.phase = phase;
    if (typeof progress === 'number') this.progress = Math.max(0, Math.min(100, progress));
    this.notify();
  }

  /* Install one process-wide dispatch rule. Local control-plane requests stay
     on the native fetch (loopback), every other fetch rides the WARP proxy.
     Electron's renderer session is pointed at the same proxy in main.js. */
  installDispatcher() {
    if (this._dispatcherInstalled) return;
    this._dispatcherInstalled = true;
    try { setGlobalDispatcher(this.agent()); } catch (e) { this.log('dispatcher: ' + e.message); }
    var nativeFetch = globalThis.fetch;
    var self = this;
    globalThis.fetch = function (input, init) {
      var u = typeof input === 'string' ? input : (input && input.url) || '';
      /* Manual OFF means honest direct routing: no dead local proxy in the
         path, no accidental kill-switch. Local control-plane stays native. */
      if (!self.enabled) {
        var d = self.directAgent();
        return d ? BASE_FETCH(input, Object.assign({}, init, { dispatcher: d })) : BASE_FETCH(input, init);
      }
      if (/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::|\/|$)/i.test(u)) {
        return nativeFetch(input, init);
      }
      return proxyFetch(input, init);
    };
    this.log('process dispatcher -> ' + PROXY_URL);
  }

  writeEndpoint(region, ip) {
    var cfgPath = this.configPath();
    var cfg = null;
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) {}
    if (!cfg || !cfg.private_key) return false;
    var list = REGION_ENDPOINTS[region] || REGION_ENDPOINTS.auto;
    var pick = ip || list[0];
    cfg.endpoint_v4 = pick;
    cfg.endpoint_h2_v4 = pick;
    try { fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2)); return true; }
    catch (e) { this.log('config write: ' + e.message); return false; }
  }

  setEndpoint(ip) {
    return this.writeEndpoint(this.region, ip);
  }

  async ensureConfig() {
    var cfgPath = this.configPath();
    var valid = false;
    try {
      var cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      valid = !!(cfg && cfg.private_key && cfg.id);
    } catch (e) {}
    if (valid) return true;
    try { fs.unlinkSync(cfgPath); } catch (e) {}
    var bin = this.binary();
    if (!bin) throw new Error('Shield core missing (bin/usque.exe)');
    this.setPhase('provisioning', 'Registering an anonymous identity', 6);
    this.log('registering anonymous WARP identity');
    await new Promise(function (resolve, reject) {
      execFile(bin, ['-c', cfgPath, 'register', '--accept-tos', '-n', 'SuperBox'],
        { windowsHide: true, timeout: 90000, maxBuffer: 1024 * 1024 },
        function (err, stdout, stderr) {
          if (err) return reject(new Error('Shield registration failed: ' + String(stderr || err.message).slice(-240)));
          resolve();
        });
    });
    this.log('registration complete');
    return true;
  }

  spawnProxy(dnsMode, transport) {
    var bin = this.binary();
    if (!bin) throw new Error('Shield core missing');
    var cfg = this.configPath();
    var useV6 = transport === 'v6';
    this.transport = useV6 ? 'ipv6' : 'ipv4';
    /* L4 CONNECT proxy: usque's plain HTTP proxy serialises work behind a
       small number of tunnels and starves when Chromium keeps several
       connections open. The L4 proxy opens one direct HTTP/3 CONNECT stream
       per request, which is exactly what a browser proxy needs. */
    /* DNS decides reachability through WARP. With local DNS the name is
       resolved by 1.1.1.1 *inside* the tunnel, so every CONNECT goes to an
       address WARP itself can route. The ISP resolver can hand back anycast
       addresses that WARP answers with 504/CRYPTO_ERROR on this network, so
       `-d 1.1.1.1` is the default; `--system-dns` stays as the fallback for
       networks that block Cloudflare DNS over the tunnel. */
    var mode = dnsMode === 'system' ? 'system' : 'cf';
    this.dnsMode = mode;
    var args = ['-c', cfg, 'l4-http-proxy'];
    if (useV6) args.push('-6');
    args.push('-b', PROXY_HOST, '-p', String(PROXY_PORT));
    if (mode === 'system') args.push('--system-dns');
    else args.push('-d', '1.1.1.1', '-d', '1.0.0.1', '-t', '5s');
    this.log('usque transport: ' + (useV6 ? 'IPv6' : 'IPv4') + '; DNS mode: ' + (mode === 'system' ? 'system resolver' : '1.1.1.1 over tunnel'));
    var child = spawn(bin, args,
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    var self = this;
    child.stdout.on('data', function (b) { self.log('usque: ' + String(b).trim().slice(0, 400)); });
    child.stderr.on('data', function (b) { self.log('usque: ' + String(b).trim().slice(0, 400)); });
    child.on('exit', function (code, sig) {
      self.log('usque exited code=' + code + ' sig=' + sig);
      if (self.child === child) {
        self.child = null;
        if (self.state === 'on' || self.state === 'connecting') {
          self.state = 'error';
          self.error = 'Shield process exited';
          self.progress = 100;
          self.phase = 'Process exited';
        }
      }
    });
    child.on('error', function (e) {
      self.log('usque spawn: ' + e.message);
      self.state = 'error';
      self.error = e.message;
    });
    this.child = child;
    return child;
  }

  /* Resolve as soon as nothing is listening on the proxy port. usque needs a
     moment to release the listener after a kill; spawning into that window
     fails with "Only one usage of each socket address". */
  async waitPortFree(timeoutMs) {
    var until = Date.now() + (timeoutMs || 7000);
    while (Date.now() < until) {
      var busy = await new Promise(function (resolve) {
        var s = net.connect({ host: PROXY_HOST, port: PROXY_PORT });
        var done = false;
        function finish(v) { if (!done) { done = true; try { s.destroy(); } catch (e) {} resolve(v); } }
        s.setTimeout(500);
        s.once('connect', function () { finish(true); });
        s.once('timeout', function () { finish(false); });
        s.once('error', function () { finish(false); });
      });
      if (!busy) return true;
      await sleep(220);
    }
    return false;
  }

  killChild() {
    var child = this.child;
    this.child = null;
    if (!child) return;
    try { child.kill(); } catch (e) {}
    if (child.exitCode === null && child.pid) {
      setTimeout(function () {
        try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (e) {}
      }, 350);
    }
  }

  stop() {
    this.killChild();
  }

  async probe() {
    if (this.probing) return this.probing;
    var self = this;
    this.probing = (async function () {
      var ctl = new AbortController();
      var tm = setTimeout(function () { try { ctl.abort(); } catch (e) {} }, 12000);
      try {
        /* Manual OFF means there is no tunnel to ask: measure the host route
           so ping/latency stays honest while disconnected. */
        var direct = !self.enabled || self.state === 'off';
        var relayMode = self.mode === 'relay' && !!self._relayAgent;
        var t0 = Date.now();
        var r = direct
          ? await BASE_FETCH(TRACE_URL, { signal: ctl.signal, cache: 'no-store' })
          : await proxyFetch(TRACE_URL, { dispatcher: relayMode ? self._relayAgent : self.agent(), signal: ctl.signal });
        if (!r.ok) throw new Error('trace HTTP ' + r.status);
        var text = await r.text();
        self.ping = Math.max(1, Date.now() - t0);
        var map = {};
        text.split(/\r?\n/).forEach(function (line) {
          var i = line.indexOf('=');
          if (i > 0) map[line.slice(0, i)] = line.slice(i + 1);
        });
        self.warp = relayMode ? false : map.warp === 'on';
        self.actual = String(map.loc || '').toUpperCase();
        self.colo = String(map.colo || '').toUpperCase();
        self.city = COLO_CITY[self.colo] || '';
        self.ip = String(map.ip || '');
        self.lastProbe = Date.now();
        if (relayMode) {
          if (self.relay && self.relay.loc && self.actual !== self.relay.loc) {
            throw new Error('relay egress moved to ' + self.actual);
          }
          return true;
        }
        return direct ? true : self.warp;
      } finally {
        clearTimeout(tm);
        self.probing = null;
      }
    })();
    return this.probing;
  }

  async waitReady(timeoutMs, label) {
    var until = Date.now() + (timeoutMs || 30000);
    var started = Date.now();
    while (Date.now() < until) {
      if (!this.child) throw new Error(this.error || 'Shield process is not running');
      try {
        if (await this.probe()) {
          this.setPhase('on', 'Tunnel live', 100);
          this.startedAt = this.startedAt || Date.now();
          this.error = '';
          this._watchFails = 0;
          this.log('tunnel ready egress=' + (this.actual || '?') + ' warp=' + this.warp);
          this.startWatchdog();
          return true;
        }
      } catch (e) {
        this.log('probe waiting: ' + String(e.message || e).slice(0, 160));
      }
      var pct = 58 + Math.min(34, Math.round((Date.now() - started) / Math.max(1, timeoutMs) * 34));
      this.setPhase('connecting', label || 'Negotiating the tunnel', pct);
      await sleep(1100);
    }
    throw new Error('Shield tunnel did not come up in time');
  }

  startWatchdog() {
    if (this._watchdog) return;
    var self = this;
    this._watchdog = setInterval(function () { self.watch(); }, WATCHDOG_MS);
    try { this._watchdog.unref(); } catch (e) {}
  }

  stopWatchdog() {
    if (this._watchdog) { try { clearInterval(this._watchdog); } catch (e) {} this._watchdog = null; }
  }

  /* Health check after the gate is open. A tunnel can die quietly (endpoint
     rotation, sleep/resume, network change). When three probes in a row fail
     the manager rebuilds it without waiting for the user to notice. */
  async watch() {
    if (!this.enabled) return;
    if (this._watchBusy || this._starting) return;
    if (this.state !== 'on') return;
    if (this.mode === 'relay') {
      if (!this._relayAgent) { this._activateRelay(this.region); return; }
    } else if (!this.child) {
      this.recover('Shield process disappeared');
      return;
    }
    this._watchBusy = true;
    try {
      var ok = false;
      try { ok = await this.probe(); } catch (e) { ok = false; }
      if (ok) { this._watchFails = 0; return; }
      this._watchFails++;
      this.log('watchdog miss ' + this._watchFails + '/' + WATCHDOG_FAILS);
      if (this._watchFails >= WATCHDOG_FAILS) {
        this._watchFails = 0;
        if (this.mode === 'relay') this._activateRelay(this.region);
        else this.recover('Tunnel stopped answering');
      }
    } finally {
      this._watchBusy = false;
    }
  }

  async recover(reason) {
    if (!this.enabled) return this.status();
    if (this._recovering || this._starting) return this._recovering;
    if (this.mode === 'relay') return this._activateRelay(this.region);
    this.log('self-repair: ' + reason);
    this.error = reason || 'Reconnecting the Shield';
    this.setPhase('connecting', 'Repairing the tunnel', 8);
    this.stopWatchdog();
    var self = this;
    this._recovering = this._bringUp(this.region, true).catch(function (e) {
      return null;
    }).finally(function () { self._recovering = null; });
    return this._recovering;
  }

  async _bringUp(region, fresh) {
    if (!this.enabled) return this.status();
    var wanted = normRegion(region || this.region);
    this.installDispatcher();
    if (this.mode === 'relay') this._clearRelay();
    try { setGlobalDispatcher(this.agent()); } catch (e) {}
    this.stopWatchdog();
    this.setPhase('connecting', 'Preparing the Shield', 2);
    this.error = '';
    this.warp = false;
    this.actual = '';
    this.colo = '';
    this.city = '';
    this.ip = '';
    this.region = wanted;
    try {
      await this.ensureConfig();
    } catch (e) {
      this.state = 'error';
      this.progress = 100;
      this.phase = 'Provisioning failed';
      this.error = (e && e.message) || 'Shield provisioning failed';
      throw e;
    }

    if (fresh || this.child) {
      this.killChild();
      this.setPhase('connecting', 'Releasing the local proxy', 12);
      await this.waitPortFree(8000);
    }

    var list = (REGION_ENDPOINTS[wanted] || REGION_ENDPOINTS.auto).slice();
    var attempts = Math.min(START_ATTEMPTS, list.length);
    var lastErr = null;

    /* IPv6 first: its anycast path bypasses IPv4-anchor congestion. A short
       budget keeps IPv4-only networks from waiting long for the fallback. */
    this.attempt = 1;
    this.endpoint = WARP_ENDPOINT_V6;
    this.setPhase('connecting', 'IPv6 anchor \u00b7 ' + WARP_ENDPOINT_V6, 16);
    this.log('start ' + wanted + ': IPv6 anchor ' + WARP_ENDPOINT_V6);
    this.spawnProxy('cf', 'v6');
    try {
      await this.waitReady(V6_READY_MS, 'Negotiating the IPv6 anchor');
    } catch (e) {
      lastErr = e;
      this.log('IPv6 anchor failed: ' + e.message);
      this.killChild();
      await this.waitPortFree(5000);
    }

    if (this.state !== 'on') for (var i = 0; i < attempts; i++) {
      this.attempt = i + 1;
      this.endpoint = list[i];
      /* First half of the ladder resolves inside the tunnel (the reliable
         path); the second half falls back to the system resolver for
         networks that answer Cloudflare DNS with nothing. */
      var dns = i < Math.ceil(attempts / 2) ? 'cf' : 'system';
      this.setPhase('connecting', 'Endpoint ' + (i + 1) + ' of ' + attempts + ' \u00b7 ' + list[i], 18 + i * 11);
      this.log('start ' + wanted + ': endpoint ' + list[i] + ' (' + (i + 1) + '/' + attempts + ', DNS ' + dns + ')');
      if (!this.writeEndpoint(wanted, list[i])) {
        lastErr = new Error('Shield config is missing');
        break;
      }
      this.warp = false;
      this.actual = '';
      this.spawnProxy(dns);
      try {
        await this.waitReady(ATTEMPT_READY_MS, 'Negotiating ' + list[i]);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        this.log('endpoint ' + list[i] + ' failed: ' + e.message);
        this.killChild();
        await this.waitPortFree(5000);
      }
    }

    /* Regional profiles could all fail (a blocked network, a bad anchor).
       One last attempt on the global anchor keeps the app usable. */
    if (this.state !== 'on' && wanted !== 'auto') {
      this.log('region ' + wanted + ' exhausted; trying the global profile');
      this.setPhase('connecting', 'Trying the global profile', 88);
      this.region = wanted; /* keep the requested label for the status report */
      this.writeEndpoint(wanted, WARP_ENDPOINTS[0]);
      this.killChild();
      await this.waitPortFree(5000);
      this.spawnProxy(this.dnsMode === 'system' ? 'cf' : 'system', 'ipv4');
      try {
        await this.waitReady(ATTEMPT_READY_MS, 'Negotiating the global anchor');
        lastErr = null;
      } catch (e) { lastErr = e; }
    }

    if (this.state !== 'on') {
      this.killChild();
      this.state = 'error';
      this.progress = 100;
      this.phase = 'No endpoint answered';
      this.error = (lastErr && lastErr.message) || 'No Shield endpoint answered';
      throw lastErr || new Error(this.error);
    }

    if (wanted !== 'auto' && this.actual && this.actual !== wanted.toUpperCase()) {
      this.error = 'Region endpoint is anycast; egress is ' + this.actual;
    }
    return this.status();
  }

  async start(region) {
    if (!this.enabled) return this.status();
    var wanted = normRegion(region || this.region);
    if (wanted !== 'auto') return this._activateRelay(wanted);
    if (this._starting) return this._starting;
    try { setGlobalDispatcher(this.agent()); } catch (e) {}
    var self = this;
    this._starting = (async function () {
      try {
        return await self._bringUp(wanted, true);
      } finally {
        self._starting = null;
      }
    })();
    return this._starting;
  }

  stopSync() {
    this.stopWatchdog();
    this.state = 'idle';
    this.warp = false;
    this.progress = 0;
    this.phase = 'idle';
    this.stop();
  }

  /* Manual OFF: the user asked for clean direct routing. Tear the tunnel down,
     tell the host session to stop using the local proxy, and report a real
     "disconnected" state (not an error) everywhere. */
  async manualOff() {
    this.log('manual OFF - direct routing');
    this.enabled = false;
    this.stopWatchdog();
    this._watchFails = 0;
    this._clearRelay();
    this.killChild();
    try { await this.waitPortFree(5000); } catch (e) {}
    try { setGlobalDispatcher(this.directAgent()); } catch (e) {}
    this.state = 'off';
    this.phase = 'Disconnected';
    this.progress = 0;
    this.warp = false;
    this.actual = '';
    this.colo = '';
    this.city = '';
    this.ip = '';
    this.startedAt = 0;
    this.error = '';
    this.notify();
    return this.status();
  }

  /* Manual ON: restore the tunnel and, when the host session listens, point
     Chromium at the local proxy again. A pinned country goes straight to its
     verified exit instead of pretending WARP moved. */
  async manualOn(region) {
    this.enabled = true;
    this.preferred = normRegion(region || this.preferred || this.region || 'auto');
    this.log('manual ON - ' + this.preferred);
    if (this.preferred !== 'auto') return this._activateRelay(this.preferred);
    return this.start('auto');
  }

  /* Host hook (main.js) so the Chromium session proxy follows manual OFF/ON.
     Called on every phase change; the host coalesces duplicate values. */
  setListener(fn) { this._onState = typeof fn === 'function' ? fn : null; }
  notify() {
    if (!this._onState) return;
    try { this._onState(this.status()); } catch (e) {}
  }

  /* Real-time latency through the current route (proxy when connected,
     host connection when the user disconnected the Shield). */
  async pingNow() {
    var t0 = Date.now();
    var ctl = new AbortController();
    var tm = setTimeout(function () { try { ctl.abort(); } catch (e) {} }, 4500);
    try {
      var opts = { signal: ctl.signal, cache: 'no-store' };
      var r = this.enabled && this.state === 'on'
        ? await proxyFetch(TRACE_URL, Object.assign({ dispatcher: this.agent() }, opts))
        : await BASE_FETCH(TRACE_URL, opts);
      await r.text();
      this.ping = Math.max(1, Date.now() - t0);
      return { ok: true, ping: this.ping, route: this.enabled && this.state === 'on' ? 'shield' : 'direct' };
    } catch (e) {
      this.ping = -1;
      return { ok: false, ping: -1, route: this.enabled ? 'shield' : 'direct', error: String((e && e.message) || e) };
    } finally {
      clearTimeout(tm);
    }
  }

  async switchRegion(region) {
    if (!this.enabled) return this.status();
    var wanted = normRegion(region);
    this.preferred = wanted;
    if (wanted === 'auto') {
      if (this.state === 'on' && this.region === 'auto' && this.warp) return this.status();
      if (this._starting) {
        try { await this._starting; } catch (e) {}
        if (this.state === 'on' && this.region === 'auto' && this.warp) return this.status();
      }
      var self = this;
      this._starting = (async function () {
        try { return await self._bringUp('auto', true); }
        finally { self._starting = null; }
      })();
      return this._starting;
    }
    if (this.state === 'on' && wanted === this.region && this.relay) return this.status();
    return this._activateRelay(wanted);
  }

  /* Non-disruptive: a source asking for a region records a preference. A
     healthy route is never torn down mid-session just to chase a country. */
  async ensure(region) {
    if (!this.enabled) return this.status();
    var wanted = normRegion(region);
    /* A source that does not care about a country must not undo a country the
       user pinned in the Shield panel. */
    if (wanted === 'auto' && this.preferred !== 'auto' && this.relay) return this.status();
    this.preferred = wanted;
    var settled = this.state === 'on' && wanted === this.region &&
      (wanted === 'auto' ? this.warp : !!this.relay);
    if (settled) return this.status();
    if (this._starting) {
      try { await this._starting; } catch (e) {}
      settled = this.state === 'on' && wanted === this.region &&
        (wanted === 'auto' ? this.warp : !!this.relay);
      if (settled) return this.status();
    }
    if (this.state === 'connecting' || this.state === 'provisioning') {
      try { await this.waitReady(20000); } catch (e) {}
      settled = this.state === 'on' && wanted === this.region &&
        (wanted === 'auto' ? this.warp : !!this.relay);
      if (settled) return this.status();
    }
    return this.switchRegion(wanted);
  }

  status() {
    var on = this.state === 'on' && (this.warp || !!this.relay);
    var relayMode = this.mode === 'relay' && !!this.relay;
    return {
      ok: on,
      connected: on,
      enabled: this.enabled,
      off: this.state === 'off' || !this.enabled,
      engine: relayMode ? 'Verified regional exit (' + (this.relay.protocol || 'relay') + ')' : 'usque/WARP MASQUE',
      mode: relayMode ? 'relay' : 'warp',
      proxy: relayMode ? this.relay.url : '',
      relayCity: relayMode ? (this.relay.city || '') : '',
      state: this.state,
      phase: this.phase,
      progress: this.progress,
      region: this.region,
      regionLabel: REGION_LABEL[this.region] || this.region,
      preferred: this.preferred,
      endpoint: this.endpoint,
      transport: this.transport,
      attempt: this.attempt,
      dns: this.dnsMode,
      egress: this.actual,
      city: this.city || (on ? (REGION_LABEL[this.region] || '') : ''),
      colo: this.colo || '',
      ip: this.ip,
      warp: this.warp,
      ping: this.ping || 0,
      port: PROXY_PORT,
      uptime: this.startedAt ? Math.max(0, Math.round((Date.now() - this.startedAt) / 1000)) : 0,
      error: this.error || '',
      checkedAt: this.lastProbe
    };
  }
}

module.exports = new VpnManager();
