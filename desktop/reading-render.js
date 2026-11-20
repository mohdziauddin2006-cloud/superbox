/* reading-render.js - native hidden renderer for the Reading room.
   ---------------------------------------------------------------------------
   Some catalogue pages build their cards, chapter lists and page strips with
   JavaScript. Fetching their HTML with Node returns a bot gate or an empty
   shell, so the reader could never be fully native. This module owns ONE
   short-lived, hidden, muted BrowserWindow per job and returns the RENDERED
   DOM (anchors, images, reader strip, metadata) to the local API.

   The window is never shown, never focused, never in the taskbar, and is
   destroyed on every exit path. It uses the app's default session, so it
   inherits the network ad shield, the Shield/VPN proxy and the app's UA.
   Only reading sites are allowed; the endpoint is a localhost-only service. */
'use strict';

const { BrowserWindow } = require('electron');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* Hosts the reading room is allowed to render. Anything else is refused so a
   stray localhost request can never turn this into an open browser. */
const ALLOW_RE = /(^|\.)(asurascans\.com|asuracomic\.net|flamecomics\.xyz|vortexscans\.org|hivetoons\.org|comix\.to|manhuaus\.club|nelomanga\.net|tappytoon\.com|tapas\.io|allmanga\.to|allanime\.day|mangafire\.to|toonsutra\.com|hentai20\.io|mangadex\.org|webtoons\.com|naver\.com|mangapark\.net|batoto\.com)$/i;

const CACHE = new Map();
const CAP_CACHE = new Map();
const TTL = { catalog: 150000, detail: 150000, chapter: 90000, other: 60000 };
let QUEUE = Promise.resolve();
let ACTIVE = 0;

function allowed(target) {
  try {
    const u = new URL(String(target || ''));
    if (!/^https?:$/i.test(u.protocol)) return false;
    return ALLOW_RE.test(u.hostname.toLowerCase());
  } catch (e) { return false; }
}

const SNAP = `(() => {
  const abs = function (u) {
    try { return new URL(u, location.href).toString(); } catch (e) { return ''; }
  };
  const firstSrc = function (im) {
    const attrs = ['data-src', 'data-lazy-src', 'data-original', 'data-url', 'data-image', 'src', 'data-cfsrc'];
    for (const a of attrs) {
      const v = im.getAttribute(a);
      if (v && !/^data:image\\/(gif|svg)/i.test(v) && !/\\/blank|placeholder|spacer|loading|transparent/i.test(v)) return v;
    }
    const ss = im.getAttribute('srcset') || im.getAttribute('data-srcset') || '';
    if (ss) { const p = ss.split(',').pop().trim().split(/\\s+/)[0]; if (p) return p; }
    return '';
  };
  const anchors = [];
  const seenA = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    const h = abs(a.getAttribute('href'));
    if (!h || seenA.has(h)) continue;
    seenA.add(h);
    const im = a.querySelector('img');
    anchors.push({
      h: h,
      t: (a.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 180),
      a: im ? (im.getAttribute('alt') || '').replace(/\\s+/g, ' ').trim().slice(0, 180) : '',
      i: im ? abs(firstSrc(im)) : ''
    });
  }
  const images = [];
  const seenI = new Set();
  for (const im of document.querySelectorAll('img')) {
    const s = abs(firstSrc(im));
    if (!s || seenI.has(s)) continue;
    seenI.add(s);
    const r = im.getBoundingClientRect();
    images.push({
      s: s,
      a: (im.getAttribute('alt') || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
      w: im.naturalWidth || 0,
      h: im.naturalHeight || 0,
      cw: Math.round(r.width || 0),
      ch: Math.round(r.height || 0),
      cls: String(im.className || '').slice(0, 100)
    });
  }
  /* Reader strips, in reading order. data-page-index wins because several
     sites render pages out of DOM order and sort them with CSS. */
  const seasoned = [];
  for (const im of document.querySelectorAll('img[data-page-index]')) {
    const s = abs(firstSrc(im));
    if (s) seasoned.push({ s: s, idx: Number(im.getAttribute('data-page-index')) || 0, w: im.naturalWidth || 0, h: im.naturalHeight || 0 });
  }
  seasoned.sort(function (x, y) { return x.idx - y.idx; });
  const readerSel = [
    '#images img', '.reading-content img', '.page-break img', '.viewer_img img',
    '[class*="reader"] img', '[class*="chapter"] img', '[class*="page"] img',
    '[class*="comic"] img', '[class*="manga"] img', 'main img'
  ].join(',');
  const readers = [];
  const seenR = new Set();
  for (const im of document.querySelectorAll(readerSel)) {
    const s = abs(firstSrc(im));
    if (!s || seenR.has(s)) continue;
    seenR.add(s);
    const r = im.getBoundingClientRect();
    readers.push({
      s: s,
      w: im.naturalWidth || 0,
      h: im.naturalHeight || 0,
      cw: Math.round(r.width || 0) || im.width || 0,
      cls: String(im.className || '').slice(0, 100)
    });
  }
  const meta = function (p, a) {
    const el = document.querySelector('meta[' + a + '="' + p + '"]') || document.querySelector('meta[' + a + "='" + p + "']");
    return el ? (el.getAttribute('content') || '') : '';
  };
  return {
    url: location.href,
    title: document.title || '',
    h1: (document.querySelector('h1') || {}).textContent || '',
    og: abs(meta('og:image', 'property')),
    desc: meta('description', 'name') || meta('og:description', 'property'),
    anchors: anchors,
    images: images,
    readers: seasoned.length ? seasoned : readers,
    text: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').slice(0, 4000),
    html: (document.documentElement ? document.documentElement.outerHTML : '').slice(0, 900000)
  };
})()`;

const SCROLL = `(async () => {
  const wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  const tall = function () { return Math.max(document.body ? document.body.scrollHeight : 0, document.documentElement.scrollHeight || 0); };
  let stable = 0, last = 0;
  for (let i = 0; i < 22; i++) {
    const h = tall();
    window.scrollTo(0, Math.min(h, (i + 1) * 1000));
    await wait(260);
    if (h === last) { stable++; if (stable >= 4 && i > 6) break; } else stable = 0;
    last = h;
  }
  window.scrollTo(0, 0);
  await wait(350);
  return tall();
})()`;

/* executeJavaScript on a renderer wedged by a hostile ad script never settles.
   Race every evaluation against a hard cap and crash the renderer on timeout
   so the window can be destroyed and the queue keeps moving. */
function evalIn(win, code, ms) {
  return Promise.race([
    win.webContents.executeJavaScript(code, true),
    new Promise(function (_resolve, reject) {
      setTimeout(function () { reject(new Error('render eval timeout')); }, ms || 9000);
    })
  ]).catch(function (e) {
    try { win.webContents.forcefullyCrashRenderer(); } catch (e2) {}
    throw e;
  });
}

function makeWindow() {
  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 2000,
    backgroundColor: '#050607',
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: true,
      images: true,
      backgroundThrottling: false,
      spellcheck: false
    }
  });
  try { win.webContents.setAudioMuted(true); } catch (e) {}
  try { win.webContents.setWindowOpenHandler(function () { return { action: 'deny' }; }); } catch (e) {}
  try { win.webContents.setUserAgent(UA); } catch (e) {}
  return win;
}

function settle(win, cap, settleMs, target) {
  return new Promise(function (resolve) {
    let done = false;
    const finish = function (ok) {
      if (done) return;
      done = true;
      clearTimeout(hard);
      try {
        win.webContents.removeListener('did-finish-load', onLoad);
        win.webContents.removeListener('did-fail-load', onFail);
      } catch (e) {}
      resolve(ok);
    };
    const onLoad = function () { setTimeout(function () { finish(true); }, settleMs); };
    const onFail = function (_e, code, desc, _u, isMain) {
      if (isMain === false) return;
      finish(!/ERR_ABORTED|ERR_FAILED|ERR_INVALID_URL/i.test(String(desc || code)));
    };
    const hard = setTimeout(function () {
      try { win.webContents.stop(); } catch (e) {}
      finish(true);
    }, cap);
    win.webContents.on('did-finish-load', onLoad);
    win.webContents.on('did-fail-load', onFail);
    try {
      win.loadURL(target || '', { userAgent: UA }).catch(function () {});
    } catch (e) { finish(false); }
  });
}

async function doRender(target, opts) {
  const kind = String(opts.kind || 'other');
  const win = makeWindow();
  const started = Date.now();
  try {
    const cap = Math.min(30000, Math.max(8000, opts.cap || (kind === 'catalog' ? 16000 : 20000)));
    const settleMs = Math.min(6000, Math.max(1200, opts.settle || 2400));
    /* settle() resolves after the page's load event plus a paint beat, or at
       the hard cap. The target URL is explicit so the window never opens
       about:blank by accident. */
    const ok = await settle(win, cap, settleMs, target);
    if (!ok) return { ok: false, error: 'page did not load', url: target };
    /* JS-heavy pages keep painting after load; wait for real text, then give
       lazy image observers one idle beat. */
    try {
      await evalIn(win,
        `(async()=>{const s=ms=>new Promise(r=>setTimeout(r,ms));for(let i=0;i<18;i++){if(document.body&&document.body.innerText.length>280)break;await s(300);}await s(1200);return 1;})()`, 9000);
    } catch (e) {}
    if (opts.scroll !== false) {
      try { await evalIn(win, SCROLL, 11000); } catch (e) {}
    }
    const data = await evalIn(win, SNAP, 9000);
    data.ok = true;
    data.took = Date.now() - started;
    return data;
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), url: target };
  } finally {
    try { win.webContents.stop(); } catch (e) {}
    try { win.destroy(); } catch (e) {}
  }
}

/* Capture JSON/text XHR bodies from a provider page. Several reading sites
   (MangaFire chapter lists/pages, Tappytoon viewer manifests) sign their APIs
   with values computed in page JavaScript and a Cloudflare clearance cookie;
   replaying the API from Node is impossible. The page is still loaded by the
   app's own hidden, muted window - this simply reads what that page fetched,
   without opening a visible browser or an external reader. */
async function doCapture(target, opts) {
  const match = opts.match;
  const want = Math.max(1, Math.min(8, Number(opts.want) || 1));
  const cap = Math.min(36000, Math.max(9000, Number(opts.cap) || 24000));
  const win = makeWindow();
  const started = Date.now();
  const dbg = win.webContents.debugger;
  const bodies = [];
  const waiting = new Map();
  let usable = false;
  let attachErr = '';
  try {
    dbg.attach('1.3');
    await Promise.race([dbg.sendCommand('Network.enable'), new Promise(function (_z, reject) {
      setTimeout(function () { reject(new Error('debugger timeout')); }, 5000);
    })]);
    usable = true;
  } catch (e) {
    attachErr = String((e && e.message) || e);
    try { dbg.detach(); } catch (e2) {}
  }
  const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  try {
    dbg.attach('1.3');
    dbg.on('message', function (_event, method, params) {
      if (method === 'Network.responseReceived') {
        const r = params.response || {};
        if (!match.test(r.url)) return;
        if (!/json|javascript|text|xml/i.test(r.mimeType || '') && !/json|graphql/i.test(r.url)) return;
        waiting.set(params.requestId, { url: r.url, status: r.status });
        return;
      }
      if (method === 'Network.loadingFinished' && waiting.has(params.requestId)) {
        const meta = waiting.get(params.requestId);
        waiting.delete(params.requestId);
        dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId }).then(function (b) {
          let text = String(b.body || '');
          if (b.base64Encoded) {
            try { text = Buffer.from(text, 'base64').toString('utf8'); } catch (e) {}
          }
          if (!text || text.length > 900000) return;
          bodies.push({ url: meta.url, status: meta.status, body: text.slice(0, 700000) });
        }).catch(function () {});
      }
    });
    usable = true;
    /* Network.enable can take a beat on a cold renderer. A slow reply is not a
       failure: domain events still arrive once it lands. */
    await Promise.race([
      dbg.sendCommand('Network.enable').catch(function () {}),
      sleep(4000)
    ]);
  } catch (e) {
    attachErr = String((e && e.message) || e);
    usable = false;
    try { dbg.detach(); } catch (e2) {}
  }
  try {
    win.loadURL(String(target), { userAgent: UA }).catch(function () {});
    let nextScroll = Date.now() + 4500;
    while (bodies.length < want && Date.now() - started < cap) {
      await sleep(500);
      if (Date.now() > nextScroll) {
        nextScroll = Date.now() + 3500;
        try {
          await evalIn(win, `(async()=>{const s=ms=>new Promise(r=>setTimeout(r,ms));const h=Math.max(document.body?document.body.scrollHeight:0,document.documentElement.scrollHeight||0);window.scrollTo(0,Math.min(h,(${Date.now() % 7 + 1})*900));await s(350);return 1})()`, 3000);
        } catch (e) {}
      }
    }
    /* Give an in-flight getResponseBody reply a beat to land before detaching. */
    await sleep(250);
    return {
      ok: bodies.length > 0,
      error: bodies.length ? undefined : (usable ? 'no matching response' : ('capture unavailable: ' + attachErr)),
      url: target, bodies: bodies, took: Date.now() - started
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), url: target, bodies: bodies };
  } finally {
    try { if (usable) dbg.detach(); } catch (e) {}
    try { win.webContents.stop(); } catch (e) {}
    try { win.destroy(); } catch (e) {}
  }
}

function capture(target, opts) {
  opts = opts || {};
  if (!allowed(target)) return Promise.resolve({ ok: false, error: 'host not allowed', bodies: [] });
  const key = String(target) + '|' + String(opts.match || '') + '|' + String(opts.want || 1);
  const now = Date.now();
  const hit = CAP_CACHE.get(key);
  if (hit && now - hit.t < 75000) return Promise.resolve(hit.v);
  if (CAP_CACHE.size > 90) {
    for (const [k, v] of CAP_CACHE) { if (now - v.t > 240000) CAP_CACHE.delete(k); }
  }
  const job = function () {
    ACTIVE++;
    return doCapture(String(target), opts).then(function (v) {
      if (v && v.ok) CAP_CACHE.set(key, { t: Date.now(), v: v });
      return v;
    }).catch(function (e) {
      return { ok: false, error: String((e && e.message) || e), bodies: [] };
    }).finally(function () { ACTIVE--; });
  };
  const p = QUEUE.then(job, job);
  QUEUE = p.then(function () {}, function () {});
  return p;
}

function render(target, opts) {
  opts = opts || {};
  if (!allowed(target)) return Promise.resolve({ ok: false, error: 'host not allowed' });
  const key = String(target) + '|' + (opts.kind || '') + '|' + (opts.scroll === false ? '0' : '1');
  const now = Date.now();
  const hit = CACHE.get(key);
  if (hit && now - hit.t < (TTL[opts.kind] || TTL.other)) return Promise.resolve(hit.v);
  if (CACHE.size > 120) {
    for (const [k, v] of CACHE) { if (now - v.t > 300000) CACHE.delete(k); }
  }
  const job = function () {
    ACTIVE++;
    return doRender(String(target), opts).then(function (v) {
      if (v && v.ok) CACHE.set(key, { t: Date.now(), v: v });
      return v;
    }).catch(function (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }).finally(function () { ACTIVE--; });
  };
  const p = QUEUE.then(job, job);
  QUEUE = p.then(function () {}, function () {});
  return p;
}

function status() {
  return { ok: true, active: ACTIVE, cached: CACHE.size };
}

module.exports = { render: render, capture: capture, status: status, allowed: allowed };
