/* relay.js - verified regional exit relays for SuperBox Shield.
   ---------------------------------------------------------------------------
   Cloudflare WARP is anycast: a country profile can only change the endpoint
   address, never the egress POP. Country selections therefore use a pool of
   real exit relays instead of pretending an anycast anchor moved.

   The pool is built from public, country-grouped relay lists, then every
   candidate is tested by asking Cloudflare's trace endpoint through it. Only
   a relay that answers with the requested country code is handed to the VPN
   manager, so the country shown in the UI is the measured egress, not a wish.

   Supported transports:
     - HTTP / HTTPS CONNECT proxies (undici ProxyAgent)
     - SOCKS5 proxies (a small connector on top of net/tls)

   The module is intentionally independent of Electron so it can be tested
   with plain `node`.
   --------------------------------------------------------------------------- */
'use strict';

const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const { Agent, ProxyAgent, fetch: ufetch } = require('undici');

const TRACE = 'https://www.cloudflare.com/cdn-cgi/trace';
const UA = 'SuperBox/1.4.1 (+https://github.com/mohdziauddin2006-cloud/superbox)';

/* ISO codes for every region the UI can request. */
const COUNTRY = {
  us: 'US', uk: 'GB', ca: 'CA', au: 'AU', in: 'IN', de: 'DE', jp: 'JP',
  sg: 'SG', hk: 'HK', kr: 'KR', fr: 'FR', br: 'BR', nl: 'NL', es: 'ES',
  it: 'IT', se: 'SE', ch: 'CH', ae: 'AE', za: 'ZA', mx: 'MX', tr: 'TR',
  id: 'ID', ph: 'PH', th: 'TH', vn: 'VN', pk: 'PK', bd: 'BD', ru: 'RU',
  pl: 'PL', pt: 'PT', ie: 'IE', nz: 'NZ'
};

const COLO_CITY = {
  BOM: 'Mumbai', DEL: 'New Delhi', MAA: 'Chennai', BLR: 'Bengaluru',
  IAD: 'Ashburn', EWR: 'Newark', LAX: 'Los Angeles', SJC: 'San Jose',
  ORD: 'Chicago', DFW: 'Dallas', MIA: 'Miami', SEA: 'Seattle',
  ATL: 'Atlanta', DEN: 'Denver', PHX: 'Phoenix', BOS: 'Boston',
  YYZ: 'Toronto', YVR: 'Vancouver', YUL: 'Montreal',
  LHR: 'London', LGW: 'London', MAN: 'Manchester',
  SYD: 'Sydney', MEL: 'Melbourne', BNE: 'Brisbane',
  FRA: 'Frankfurt', MUC: 'Munich', DUS: 'D\u00fcsseldorf',
  NRT: 'Tokyo', KIX: 'Osaka', SIN: 'Singapore', HKG: 'Hong Kong',
  ICN: 'Seoul', CDG: 'Paris', MRS: 'Marseille', GRU: 'S\u00e3o Paulo',
  AMS: 'Amsterdam', MAD: 'Madrid', FCO: 'Rome', WAW: 'Warsaw'
};

const CACHE_TTL = 10 * 60 * 1000;
const LIST_TTL = 10 * 60 * 1000;
const MAX_CANDIDATES = 260;

let cacheFile = '';
let listCache = {};       /* cc -> { at, list } */
let exitCache = {};       /* cc -> { at, exit } */
let cacheLoaded = false;
const directAgent = new Agent({ connect: { timeout: 20000 }, connections: 4 });

function configure(opts) {
  if (opts && opts.cacheFile) {
    cacheFile = opts.cacheFile;
    loadCache();
  }
}

function loadCache() {
  if (cacheLoaded || !cacheFile) return;
  cacheLoaded = true;
  try {
    var raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (raw && typeof raw === 'object') exitCache = raw;
  } catch (e) { exitCache = {}; }
}

function saveCache() {
  if (!cacheFile) return;
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    var now = Date.now();
    var keep = {};
    Object.keys(exitCache).forEach(function (k) {
      if (exitCache[k] && now - (exitCache[k].at || 0) < 6 * 60 * 60 * 1000) keep[k] = exitCache[k];
    });
    fs.writeFileSync(cacheFile, JSON.stringify(keep, null, 2));
  } catch (e) {}
}

function countryOf(region) { return COUNTRY[String(region || '').toLowerCase()] || ''; }

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* Minimal SOCKS5 connector for undici. DNS is resolved by the relay (ATYP 3),
   which avoids leaking lookups to the ISP and lets the relay reach hosts that
   only resolve in its own region. */
function socksConnector(proxyHost, proxyPort) {
  return function connect(opts, callback) {
    var socket = net.connect({ host: proxyHost, port: proxyPort });
    var done = false;
    function fail(err) {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch (e) {}
      callback(err || new Error('SOCKS5 failed'));
    }
    socket.setTimeout(opts.timeout || 10000, function () { fail(new Error('SOCKS5 timeout')); });
    socket.once('error', fail);
    socket.once('connect', function () {
      socket.setTimeout(0);
      socket.write(Buffer.from([5, 1, 0]));
      var hello = Buffer.alloc(0);
      function onHello(chunk) {
        hello = Buffer.concat([hello, chunk]);
        if (hello.length < 2) return;
        socket.removeListener('data', onHello);
        if (hello[0] !== 5 || hello[1] !== 0) return fail(new Error('SOCKS5 auth rejected'));
        var host = String(opts.hostname || '');
        var head = Buffer.from([5, 1, 0, 3, Buffer.byteLength(host)]);
        var tail = Buffer.alloc(2);
        tail.writeUInt16BE(opts.port || 443, 0);
        socket.write(Buffer.concat([head, Buffer.from(host), tail]));
        var reply = Buffer.alloc(0);
        function onReply(chunk) {
          reply = Buffer.concat([reply, chunk]);
          if (reply.length < 5) return;
          socket.removeListener('data', onReply);
          if (reply[1] !== 0) return fail(new Error('SOCKS5 connect rejected (' + reply[1] + ')'));
          socket.pause();
          if (opts.protocol === 'https:') {
            var secure = tls.connect({
              socket: socket,
              servername: opts.servername || host,
              ALPNProtocols: ['http/1.1']
            });
            secure.once('secureConnect', function () {
              if (done) return;
              done = true;
              callback(null, secure);
            });
            secure.once('error', fail);
          } else {
            done = true;
            callback(null, socket);
          }
        }
        socket.on('data', onReply);
      }
      socket.on('data', onHello);
    });
  };
}

function dispatcherFor(exit) {
  if (exit.protocol === 'socks5') {
    return new Agent({
      connect: socksConnector(exit.host, exit.port),
      connections: 6,
      connectTimeout: 12000,
      headersTimeout: 30000,
      bodyTimeout: 30000
    });
  }
  return new ProxyAgent({
    uri: exit.url,
    connectTimeout: 12000,
    headersTimeout: 30000,
    bodyTimeout: 30000,
    keepAliveTimeout: 10000
  });
}

function parseTrace(text) {
  var map = {};
  String(text || '').split(/\r?\n/).forEach(function (line) {
    var i = line.indexOf('=');
    if (i > 0) map[line.slice(0, i)] = line.slice(i + 1);
  });
  return map;
}

async function traceThrough(exit, ms, shared) {
  var dispatcher = shared || dispatcherFor(exit);
  var ctl = new AbortController();
  var tm = setTimeout(function () { try { ctl.abort(); } catch (e) {} }, ms || 8000);
  try {
    var r = await ufetch(TRACE, {
      dispatcher: dispatcher,
      signal: ctl.signal,
      cache: 'no-store',
      headers: { 'User-Agent': UA, 'Accept': 'text/plain' }
    });
    if (!r.ok) throw new Error('trace HTTP ' + r.status);
    var text = await r.text();
    var map = parseTrace(text);
    return {
      loc: String(map.loc || '').toUpperCase(),
      ip: String(map.ip || ''),
      colo: String(map.colo || '').toUpperCase()
    };
  } finally {
    clearTimeout(tm);
    if (!shared) { try { dispatcher.close(); } catch (e) {} }
  }
}

function parseLines(text, fallbackProtocol) {
  var out = [];
  String(text || '').split(/\r?\n/).forEach(function (line) {
    line = line.trim();
    if (!line || line.charAt(0) === '#' || line.indexOf('<') >= 0) return;
    var m = line.match(/^(https?|socks5):\/\/([^:\s\/]+):(\d{2,5})$/i);
    if (m) {
      out.push({ protocol: m[1].toLowerCase(), host: m[2], port: Number(m[3]), url: line });
      return;
    }
    m = line.match(/^([^:\s\/]+):(\d{2,5})$/);
    if (m) {
      var proto = fallbackProtocol || 'http';
      out.push({ protocol: proto, host: m[1], port: Number(m[2]), url: proto + '://' + m[1] + ':' + m[2] });
    }
  });
  return out;
}

async function fetchText(url, ms) {
  var ctl = new AbortController();
  var tm = setTimeout(function () { try { ctl.abort(); } catch (e) {} }, ms || 12000);
  try {
    var r = await ufetch(url, {
      dispatcher: directAgent,
      signal: ctl.signal,
      cache: 'no-store',
      headers: { 'User-Agent': UA, 'Accept': 'text/plain,application/json;q=0.9,*/*;q=0.5' }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally {
    clearTimeout(tm);
  }
}

async function fetchCandidates(cc) {
  var now = Date.now();
  var cached = listCache[cc];
  if (cached && now - cached.at < LIST_TTL) return cached.list;

  var jobs = [
    { url: 'https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/countries/' + cc + '/data.txt' },
    { url: 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/countries/' + cc + '/data.txt' },
    { url: 'https://api.proxyscrape.com/v2/?request=getproxies&protocol=socks5&timeout=10000&country=' + cc, proto: 'socks5' },
    { url: 'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=' + cc, proto: 'http' },
    { url: 'https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc&country=' + cc + '&protocols=socks5,http', json: true }
  ];
  var results = await Promise.allSettled(jobs.map(function (j) { return fetchText(j.url, 14000); }));
  var all = [];
  results.forEach(function (r, i) {
    if (r.status !== 'fulfilled') return;
    if (jobs[i].json) {
      try {
        var doc = JSON.parse(r.value);
        (doc.data || []).forEach(function (p) {
          var protos = p.protocols || [];
          var proto = protos.indexOf('socks5') >= 0 ? 'socks5'
            : (protos.indexOf('http') >= 0 ? 'http' : '');
          if (!proto || !p.ip || !p.port) return;
          all.push({
            protocol: proto,
            host: String(p.ip),
            port: Number(p.port),
            url: proto + '://' + p.ip + ':' + p.port
          });
        });
      } catch (e) {}
      return;
    }
    all = all.concat(parseLines(r.value, jobs[i].proto));
  });

  var seen = {};
  var socks = [], http = [];
  all.forEach(function (c) {
    if (!c.port || c.port < 1 || c.port > 65535) return;
    /* Chromium understands socks5:// and http=host:port; TLS-to-proxy
       entries are excluded because public lists label CONNECT-capable HTTP
       proxies as "https", and treating those as TLS would break the rule. */
    if (c.protocol !== 'http' && c.protocol !== 'socks5') return;
    var key = c.protocol + '://' + c.host + ':' + c.port;
    if (seen[key]) return;
    seen[key] = 1;
    (c.protocol === 'socks5' ? socks : http).push(c);
  });
  /* Interleave so a dead protocol family cannot starve the scan. */
  var list = [];
  var max = Math.max(socks.length, http.length);
  for (var i = 0; i < max && list.length < MAX_CANDIDATES; i++) {
    if (socks[i]) list.push(socks[i]);
    if (http[i]) list.push(http[i]);
  }
  listCache[cc] = { at: now, list: list };
  return list;
}

async function verifyCandidate(cand, cc) {
  var dispatcher = null;
  try {
    dispatcher = dispatcherFor(cand);
    var t = await traceThrough(cand, 8000, dispatcher);
    if (t.loc !== cc) return null;
    /* A proxy can pass the trace host and still intercept other domains with
       a certificate Chromium will reject. A second TLS host catches the most
       common intercepting relays before they are handed to the browser. */
    var probe = await ufetch('https://icanhazip.com/', {
      dispatcher: dispatcher,
      signal: AbortSignal.timeout(7000),
      cache: 'no-store',
      headers: { 'User-Agent': UA, 'Accept': 'text/plain' }
    });
    if (!probe.ok) return null;
    var seen = (await probe.text()).trim();
    if (!/^[0-9a-f:.]+$/i.test(seen)) return null;
    return {
      protocol: cand.protocol,
      host: cand.host,
      port: cand.port,
      url: cand.url,
      loc: t.loc,
      ip: t.ip,
      colo: t.colo,
      city: COLO_CITY[t.colo] || ''
    };
  } catch (e) {
    return null;
  } finally {
    if (dispatcher) { try { dispatcher.close(); } catch (e) {} }
  }
}

async function findExit(region, opts) {
  opts = opts || {};
  var cc = countryOf(region);
  if (!cc) throw new Error('Unknown region: ' + region);
  loadCache();

  /* A warm cache makes a repeat switch instant; it is re-probed so a dead
     relay never survives a launch. */
  var cached = exitCache[cc];
  if (cached && cached.exit && cached.exit.protocol !== 'https' && Date.now() - (cached.at || 0) < CACHE_TTL) {
    var fresh = await verifyCandidate(cached.exit, cc);
    if (fresh) {
      exitCache[cc] = { at: Date.now(), exit: fresh };
      saveCache();
      return fresh;
    }
    delete exitCache[cc];
  }

  if (opts.onProgress) opts.onProgress(0, 1, 'Fetching ' + cc + ' relay list');
  var list = await fetchCandidates(cc);
  if (!list.length) throw new Error('No ' + cc + ' relay candidates published');
  if (opts.onProgress) opts.onProgress(0, list.length, 'Testing ' + list.length + ' ' + cc + ' relays');

  var deadline = Date.now() + (opts.timeout || 45000);
  var idx = 0;
  var found = null;
  var checked = 0;

  async function worker() {
    while (!found && Date.now() < deadline) {
      var i = idx++;
      if (i >= list.length) return;
      var hit = await verifyCandidate(list[i], cc);
      checked++;
      if (opts.onProgress) opts.onProgress(checked, list.length, 'Testing ' + cc + ' relays');
      if (hit) { found = hit; return; }
    }
  }

  var workers = [];
  for (var w = 0; w < 10; w++) workers.push(worker());
  await Promise.all(workers);

  if (!found) throw new Error('No live ' + cc + ' exit answered in time');
  exitCache[cc] = { at: Date.now(), exit: found };
  saveCache();
  return found;
}

async function probeExit(exit) {
  if (!exit || !exit.loc) return null;
  return verifyCandidate(exit, exit.loc);
}

function clearCache() {
  exitCache = {};
  saveCache();
}

module.exports = {
  COUNTRY: COUNTRY,
  configure: configure,
  countryOf: countryOf,
  findExit: findExit,
  probeExit: probeExit,
  dispatcherFor: dispatcherFor,
  traceThrough: traceThrough,
  clearCache: clearCache
};
