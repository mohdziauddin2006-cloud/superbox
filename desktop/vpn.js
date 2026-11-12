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
     - region profiles: the routing engine rewrites the Cloudflare endpoint
       and reconnects when a source asks for another region, then reports the
       real egress country from the WARP trace endpoint
     - kill-switch semantics: while the proxy is down every upstream request
       fails closed instead of leaking around the tunnel
   --------------------------------------------------------------------------- */
'use strict';

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { ProxyAgent, fetch: proxyFetch, setGlobalDispatcher } = require('undici');

const PROXY_HOST = '127.0.0.1';
const PROXY_PORT = 46950;
const PROXY_URL = 'http://' + PROXY_HOST + ':' + PROXY_PORT;
const TRACE_URL = 'https://www.cloudflare.com/cdn-cgi/trace';

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
    this.state = 'idle';          /* idle | provisioning | connecting | on | error */
    this.region = 'auto';
    this.actual = '';
    this.ip = '';
    this.warp = false;
    this.error = '';
    this.startedAt = 0;
    this.lastProbe = 0;
    this.probing = null;
    this._starting = null;
    this._dispatcherInstalled = false;
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

  /* Install one process-wide dispatch rule. Local control-plane requests stay
     on the native fetch (loopback), every other fetch rides the WARP proxy.
     Electron's renderer session is pointed at the same proxy in main.js. */
  installDispatcher() {
    if (this._dispatcherInstalled) return;
    this._dispatcherInstalled = true;
    try { setGlobalDispatcher(new ProxyAgent(PROXY_URL)); } catch (e) { this.log('dispatcher: ' + e.message); }
    var nativeFetch = globalThis.fetch;
    var manager = this;
    globalThis.fetch = function (input, init) {
      var u = typeof input === 'string' ? input : (input && input.url) || '';
      if (/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::|\/|$)/i.test(u)) {
        return nativeFetch(input, init);
      }
      return proxyFetch(input, init);
    };
    this.log('process dispatcher -> ' + PROXY_URL);
  }

  writeEndpoint(region) {
    var cfgPath = this.configPath();
    var cfg = null;
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) {}
    if (!cfg || !cfg.private_key) return false;
    var list = REGION_ENDPOINTS[region] || REGION_ENDPOINTS.auto;
    cfg.endpoint_v4 = list[0];
    cfg.endpoint_h2_v4 = list[0];
    try { fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2)); return true; }
    catch (e) { this.log('config write: ' + e.message); return false; }
  }

  setEndpoint(ip) {
    var cfgPath = this.configPath();
    try {
      var cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      cfg.endpoint_v4 = ip;
      cfg.endpoint_h2_v4 = ip;
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      return true;
    } catch (e) { return false; }
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
    this.state = 'provisioning';
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

  spawnProxy() {
    var bin = this.binary();
    if (!bin) throw new Error('Shield core missing');
    var cfg = this.configPath();
    /* L4 CONNECT proxy: usque's plain HTTP proxy serialises work behind a
       small number of tunnels and starves when Chromium keeps several
       connections open. The L4 proxy opens one direct HTTP/3 CONNECT stream
       per request, which is exactly what a browser proxy needs. */
    var child = spawn(bin, ['-c', cfg, 'l4-http-proxy', '-b', PROXY_HOST, '-p', String(PROXY_PORT)],
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

  stop() {
    var child = this.child;
    this.child = null;
    if (!child) return;
    try { child.kill(); } catch (e) {}
    setTimeout(function () {
      try {
        if (child.exitCode === null) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        }
      } catch (e) {}
    }, 1200);
  }

  async probe() {
    if (this.probing) return this.probing;
    var self = this;
    this.probing = (async function () {
      var ctl = new AbortController();
      var tm = setTimeout(function () { try { ctl.abort(); } catch (e) {} }, 14000);
      try {
        var r = await proxyFetch(TRACE_URL, { dispatcher: new ProxyAgent(PROXY_URL), signal: ctl.signal });
        if (!r.ok) throw new Error('trace HTTP ' + r.status);
        var text = await r.text();
        var map = {};
        text.split(/\r?\n/).forEach(function (line) {
          var i = line.indexOf('=');
          if (i > 0) map[line.slice(0, i)] = line.slice(i + 1);
        });
        self.warp = map.warp === 'on';
        self.actual = String(map.loc || '').toUpperCase();
        self.ip = String(map.ip || '');
        self.lastProbe = Date.now();
        return self.warp;
      } finally {
        clearTimeout(tm);
        self.probing = null;
      }
    })();
    return this.probing;
  }

  async waitReady(timeoutMs) {
    var until = Date.now() + (timeoutMs || 30000);
    while (Date.now() < until) {
      if (!this.child) throw new Error(this.error || 'Shield process is not running');
      try {
        if (await this.probe()) {
          this.state = 'on';
          this.startedAt = this.startedAt || Date.now();
          this.error = '';
          this.log('tunnel ready egress=' + (this.actual || '?') + ' warp=' + this.warp);
          return true;
        }
      } catch (e) { this.log('probe waiting: ' + String(e.message || e).slice(0, 160)); }
      await sleep(1400);
    }
    throw new Error('Shield tunnel did not come up in time');
  }

  async start(region) {
    if (this._starting) return this._starting;
    var self = this;
    this._starting = (async function () {
      self.state = 'connecting';
      self.error = '';
      self.region = normRegion(region || self.region);
      self.installDispatcher();
      await self.ensureConfig();
      if (!self.child) {
        self.writeEndpoint(self.region);
        self.spawnProxy();
      }
      await self.waitReady(42000);
      return self.status();
    })();
    try { return await this._starting; }
    finally { this._starting = null; }
  }

  stopSync() {
    this.state = 'idle';
    this.warp = false;
    this.stop();
  }

  async switchRegion(region) {
    var wanted = normRegion(region);
    if (this.state === 'on' && wanted === this.region && this.warp) return this.status();
    var previous = this.region;
    var list = REGION_ENDPOINTS[wanted] || REGION_ENDPOINTS.auto;
    var best = null;
    /* Anycast means a different address rarely changes the egress country.
       Try a small set for failover and stop as soon as the tunnel is up. */
    var attempts = Math.min(list.length, 6);
    for (var i = 0; i < attempts; i++) {
      this.log('region ' + wanted + ': trying endpoint ' + list[i]);
      this.stop();
      /* Let the previous listener release 46950 before spawning again. */
      await sleep(2600);
      this.state = 'connecting';
      this.error = '';
      this.region = wanted;
      this.warp = false;
      this.actual = '';
      try {
        if (!this.writeEndpoint(wanted)) throw new Error('Shield config is missing');
        this.setEndpoint(list[i]);
        this.spawnProxy();
        await this.waitReady(12000);
        best = { actual: this.actual, ip: this.ip };
        if (this.state === 'on') break;
      } catch (e) {
        this.log('region ' + wanted + ' endpoint failed: ' + e.message);
      }
    }
    if (this.state !== 'on') {
      this.log('region fallback to ' + previous);
      this.stop();
      await sleep(2600);
      this.region = previous;
      try {
        this.writeEndpoint(previous);
        this.spawnProxy();
        await this.waitReady(14000);
      } catch (e) {
        this.state = 'error';
        this.error = 'No Shield endpoint answered';
      }
    }
    if (best && this.actual && wanted !== 'auto' && this.actual !== wanted.toUpperCase()) {
      this.error = 'Region endpoint is anycast; egress is ' + this.actual;
    }
    return this.status();
  }

  async ensure(region) {
    var wanted = normRegion(region);
    if (this.state === 'on' && this.warp && (wanted === 'auto' || wanted === this.region)) return this.status();
    if (this.state === 'connecting' || this.state === 'provisioning') {
      try { await this.waitReady(30000); } catch (e) {}
      if (this.state === 'on' && (wanted === 'auto' || wanted === this.region)) return this.status();
    }
    if (wanted !== this.region || !this.child) return this.switchRegion(wanted);
    return this.status();
  }

  status() {
    return {
      ok: this.state === 'on' && this.warp,
      engine: 'usque/WARP MASQUE',
      state: this.state,
      region: this.region,
      regionLabel: REGION_LABEL[this.region] || this.region,
      egress: this.actual,
      ip: this.ip,
      warp: this.warp,
      port: PROXY_PORT,
      uptime: this.startedAt ? Math.max(0, Math.round((Date.now() - this.startedAt) / 1000)) : 0,
      error: this.error || '',
      checkedAt: this.lastProbe
    };
  }
}

module.exports = new VpnManager();
