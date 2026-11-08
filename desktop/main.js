/* Provider CDNs frequently use expired / self-signed / incomplete-chain
   certificates. Disable strict TLS verification for the Node side BEFORE any
   module (including srv2.js) can open a socket. */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

/* main.js - SuperBox (Electron main process)
   ----------------------------------------------------------------------------
   1. One BrowserWindow that loads the local UI with loadFile() - no localhost
      static server, no port 46900, no "UI failed to load" class of errors.
   2. Network-level ad / tracker / popup shield: ONE onBeforeRequest listener
      with a media-extension allowlist so legitimate stream hosts are NEVER
      eaten by the rule regex.
   3. Response-header surgery: X-Frame-Options and CSP frame-ancestors are
      stripped from every response, so valid external video players are
      permitted to render inside the application window.
   4. setWindowOpenHandler -> deny on every web contents: no popups, no
      top-level ad hijacks.
   5. The SuperBox backend (srv2.js) runs alongside on 46901-46903 and now
      also serves the SuperBox catalog + play resolver.
   --------------------------------------------------------------------------- */
const { app, BrowserWindow, shell, ipcMain, session, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

/* One instance only: launching the shortcut twice focuses the open window. */
const gotLock = app.requestSingleInstanceLock();
/* Headless verification mode: the UI still renders (and CDP works) but no
   window is ever shown. Used by CI and by the agent's background tests. */
const HEADLESS = process.env.SB_HEADLESS === '1';
/* Headless verification must be completely silent: Chromium's audio output is
   disabled at the process level, and the window is additionally muted below.
   This applies only to SB_HEADLESS runs - a normal user launch keeps sound. */
if (HEADLESS) {
  app.commandLine.appendSwitch('mute-audio');
  app.commandLine.appendSwitch('disable-audio-output');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
}
if (!gotLock) {
  app.exit(0);
} else {
  app.on('second-instance', function () {
    if (!win || win.isDestroyed() || HEADLESS) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

/* ---------------------------------------------------------------------------
   CRASH / STARTUP INSTRUMENTATION
   A packaged app has no visible terminal: anything thrown before the window
   opens would look like "double-click did nothing". Every boot milestone and
   every uncaught error is therefore written to a persistent log first, then
   surfaced in a native error box. Logging itself can never throw.
   --------------------------------------------------------------------------- */
let LOG_FILE = '';
function pickLogFile() {
  const candidates = [];
  try { candidates.push(path.join(app.getPath('userData'), 'superbox.log')); } catch (e) {}
  try {
    if (process.env.PORTABLE_EXECUTABLE_DIR) {
      candidates.push(path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'SuperBox.log'));
    }
  } catch (e) {}
  try { candidates.push(path.join(path.dirname(process.execPath), 'SuperBox.log')); } catch (e) {}
  try { candidates.push(path.join(os.tmpdir(), 'SuperBox.log')); } catch (e) {}
  for (let i = 0; i < candidates.length; i++) {
    try {
      fs.mkdirSync(path.dirname(candidates[i]), { recursive: true });
      fs.appendFileSync(candidates[i], '');
      return candidates[i];
    } catch (e) {}
  }
  return '';
}
LOG_FILE = pickLogFile();

function logLine(level, message, err) {
  let detail = '';
  if (err) {
    detail = ' :: ' + (err && err.stack ? err.stack : String(err));
  }
  const line = '[' + new Date().toISOString() + '] [' + level + '] ' + message + detail + '\n';
  try { if (LOG_FILE) fs.appendFileSync(LOG_FILE, line); } catch (e) {}
  /* A detached / packaged launch has no stderr reader. Writing to a broken
     pipe raises an async EPIPE on the stream (not a throw), which used to
     reach uncaughtException and pop a modal error box on a healthy app.
     The file log above is the source of truth; stderr is best-effort only. */
  try {
    if (process.stderr && process.stderr.writable && !process.stderr.destroyed) {
      process.stderr.write(line, function () {});
    }
  } catch (e) {}
}
try { process.stderr.on('error', function () {}); } catch (e) {}

function showFatal(title, message, err) {
  logLine('FATAL', message, err);
  try {
    const detail = err && err.stack ? err.stack : (err ? String(err) : '');
    dialog.showErrorBox(
      'SuperBox - ' + title,
      message + '\n\n' + detail + (LOG_FILE ? '\n\nLog file:\n' + LOG_FILE : '')
    );
  } catch (e) {}
}

process.on('uncaughtException', function (err) {
  if (err && (err.code === 'EPIPE' || err.code === 'ECONNRESET')) {
    logLine('WARN', 'Ignored stream error: ' + err.code);
    return;
  }
  showFatal('Crash', 'The application hit an unrecoverable error.', err);
});
process.on('unhandledRejection', function (reason) {
  logLine('ERROR', 'Unhandled promise rejection', reason);
});

app.on('child-process-gone', function (_event, details) {
  try { logLine('ERROR', 'Child process gone: ' + JSON.stringify(details)); } catch (e) {}
});
app.on('render-process-gone', function (_event, _contents, details) {
  try { logLine('ERROR', 'Renderer process gone: ' + JSON.stringify(details)); } catch (e) {}
});
app.on('gpu-process-crashed', function (_event, killed) {
  logLine('ERROR', 'GPU process crashed (killed=' + killed + ')');
});
process.on('exit', function (code) { logLine('INFO', 'Process exit code ' + code); });

logLine('INFO', 'Boot start | version=' + app.getVersion() + ' | electron=' + process.versions.electron +
  ' | node=' + process.versions.node + ' | exe=' + process.execPath + ' | dir=' + __dirname);

app.userAgentFallback =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* Each external site gets its own renderer process: a broken stream page can
   never take the app's own renderer down. Autoplay + timers run unthrottled so
   provider playback and watchdogs stay accurate. */
app.commandLine.appendSwitch('site-per-process');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

/* ---------------------------------------------------------------------------
   EMBEDDED BACKEND (srv2.js)
   It starts the HTTP listeners as a require side effect. A failure there must
   never take the main process down before the UI has a chance to open, so the
   load is isolated and reported instead of escaping to the top level.
   --------------------------------------------------------------------------- */
let proxyError = null;
try {
  global.__superboxLog = logLine;
  require(path.join(__dirname, 'srv2.js'));
  logLine('INFO', 'srv2.js loaded; backend listeners requested on 46901-46903');
  /* A listener that failed to bind must not look like a healthy backend. */
  setTimeout(function () {
    try {
      const mod = require(path.join(__dirname, 'srv2.js'));
      logLine('INFO', 'srv2 live port=' + mod.LIVE_PORT() +
        ' startError=' + (mod.START_ERROR() ? String(mod.START_ERROR().message || mod.START_ERROR()) : 'none'));
    } catch (e) {}
  }, 1200);
} catch (err) {
  proxyError = err;
  logLine('ERROR', 'srv2.js failed to initialise', err);
}

let win = null;

/* ---------------------------------------------------------------------------
   AGGRESSIVE AD & POPUP SHIELD
   One regex covers every known ad network, tracker, popunder farm and generic
   ad-serving path. Real media files are explicitly allow-listed BEFORE the
   regex runs, so a legitimate stream host can never be blocked by accident.
   --------------------------------------------------------------------------- */
const AD_BLOCK_RE = new RegExp([
  'doubleclick', 'googlesyndication', 'googleadservices', 'google-analytics', 'googletagmanager', 'adservice',
  'exoclick', 'exosrv', 'exdynsrv', 'realsrv', 'magsrv', 'juicyads', 'trafficjunky', 'trafficstars', 'trafficfactory',
  'popads', 'popcash', 'propellerads', 'adsterra', 'hilltopads', 'clickadu', 'clickaine', 'onclickads',
  'tsyndicate', 'mgid', 'outbrain', 'taboola', 'adnxs', 'criteo', 'pubmatic', 'rubiconproject', 'openx',
  'smartadserver', 'adform', 'amazon-adsystem', 'admaven', 'adspyglass', 'adcash', 'adroll', 'adtrue', 'adyoulike',
  'adnium', 'adplugg', 'adpushup', 'adriver', 'bidswitch', 'casalemedia', 'districtm', 'gumgum', 'inmobi',
  'loopme', 'nativeads', 'onetag', 'sharethrough', 'smaato', 'sonobi', 'spotx', 'teads', 'tremor', 'triplelift',
  'unrulymedia', 'vidazoo', 'viqeo', 'yieldmo', 'zergnet', 'revcontent', 'histats', 'statcounter',
  'quantserve', 'scorecardresearch', 'clckd', 'afu\\.php', 'wwdme', 'popunder', 'preroll',
  'adserver', 'adsbygoogle', 'vast\\.xml', 'vpaid', 'adtng',
  'youtube\\.com\\/api\\/stats\\/ads', 'youtube\\.com\\/pagead', 'youtube\\.com\\/ptracking',
  'youtube\\.com\\/api\\/stats\\/qoe', 'youtube\\.com\\/get_midroll_info', 'youtubei\\/v1\\/log_event'
].join('|'), 'i');

const MEDIA_ALLOW_RE = /\.(mp4|m3u8|ts|m4v|webm|mpd|vtt|srt|key)(\?|#|$)/i;

function isBlockedUrl(u) {
  if (!u) return false;
  const s = String(u);
  /* NEVER block the app's own local servers or local files. */
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(s)) return false;
  if (/^file:\/\//i.test(s)) return false;
  /* NEVER block YouTube's actual media CDN or poster CDN. The ad regex only
     targets YouTube's ad/telemetry paths, never googlevideo itself. */
  if (/^https?:\/\/[^/]*(googlevideo\.com|ytimg\.com|youtube-nocookie\.com\/embed)/i.test(s)) return false;
  /* NEVER block real media files - ads almost never wear a media extension,
     while legitimate stream hosts always do. */
  if (MEDIA_ALLOW_RE.test(s)) return false;
  try { return AD_BLOCK_RE.test(s); } catch (e) { return false; }
}

function hardenContents(contents) {
  try {
    contents.setWindowOpenHandler(function () { return { action: 'deny' }; });
    contents.on('will-navigate', function (event, navigationUrl) {
      try {
        const parsed = new URL(navigationUrl);
        if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') return;
        if (parsed.protocol === 'file:') return;
      } catch (e) {}
      event.preventDefault();
    });
  } catch (e) {}
}

/* Cloudflare challenge sniff: Electron's own network stack sees every
   subframe response, so a challenged embed (403/503 + cf-mitigated, or a
   turnstile challenge-platform load) is reported to the renderer BEFORE the
   user could ever stare at "Verifying you are not a robot". */
function cfSniff(details, why) {
  try {
    if (!win || win.isDestroyed() || !win.webContents) return;
    const chain = [];
    let f = details.frame;
    for (let i = 0; f && i < 5; i++) {
      try { if (f.url) chain.push(String(f.url).slice(0, 200)); } catch (e) {}
      f = f.parent;
    }
    win.webContents.send('wab:cf', {
      u: String(details.url || '').slice(0, 240),
      c: chain,
      s: details.statusCode || 0,
      w: why || '',
      t: Date.now()
    });
  } catch (e) {}
}

function createWindow() {
  win = new BrowserWindow({
    width: 1500, height: 940, minWidth: 1080, minHeight: 680,
    backgroundColor: '#050705', autoHideMenuBar: true, title: 'SuperBox',
    show: false,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
      /* The preload also runs inside every direct player iframe - that is how
         a cross-origin embed's dead-media text and media progress reach the
         app without any DOM privileges. */
      nodeIntegrationInSubFrames: true,
      /* External sources play inside sandboxed iframes fed by the local proxy;
         the shell session needs DOM storage, mixed content and per-source user
         agents without ever sharing the app's renderer. */
      webSecurity: false, allowRunningInsecureContent: true,
      backgroundThrottling: false, domStorageEnabled: true,
      spellcheck: false
    }
  });
  /* Belt and braces: even if a page tries to force audio, the headless
     verification window is muted at the webContents level. */
  if (HEADLESS) {
    try { win.webContents.setAudioMuted(true); } catch (e) {}
    win.webContents.on('did-frame-finish-load', function () {
      if (!win || win.isDestroyed()) return;
      try { win.webContents.setAudioMuted(true); } catch (e) {}
    });
  }
  const appUrl = 'file:///' + path.join(__dirname, 'index.html').replace(/\\/g, '/');
  logLine('INFO', 'Creating window for ' + appUrl);
  win.once('ready-to-show', function () {
    if (!win || win.isDestroyed()) return;
    if (!HEADLESS) win.show();
    logLine('INFO', 'Window ready-to-show; visible=' + win.isVisible());
  });
  win.loadFile(path.join(__dirname, 'index.html')).catch(function (err) {
    showFatal('UI failed to load', 'The app UI could not be loaded from ' + appUrl, err);
  });
  hardenContents(win.webContents);
  try { win.setMenuBarVisibility(false); } catch (e) {}

  win.webContents.on('did-finish-load', function () {
    logLine('INFO', 'UI finished loading: ' + appUrl);
  });
  win.webContents.on('did-fail-load', function (_e, code, desc, failedUrl, isMainFrame) {
    logLine('ERROR', 'did-fail-load code=' + code + ' desc=' + desc + ' url=' + failedUrl + ' main=' + isMainFrame);
    if (isMainFrame) {
      showFatal('UI failed to load',
        'The window could not load ' + failedUrl + '\nError ' + code + ': ' + desc, null);
    }
  });
  win.webContents.on('console-message', function (_e, level, message) {
    if (level >= 2) logLine('RENDERER', String(message || '').slice(0, 2000));
  });
  win.on('closed', function () { logLine('INFO', 'Window closed'); win = null; });

  /* Self-heal: if the app's own renderer ever dies or wedges, reload it
     automatically instead of leaving a black unresponsive window. */
  let lastHeal = 0;
  win.webContents.on('render-process-gone', function (_e, details) {
    logLine('ERROR', 'Renderer gone: ' + JSON.stringify(details || {}));
    const now = Date.now();
    if (now - lastHeal < 10000) return;
    lastHeal = now;
    setTimeout(function () {
      if (!win || win.isDestroyed()) return;
      Promise.race([
        win.webContents.executeJavaScript('1+1', true).catch(function () { throw new Error('dead'); }),
        new Promise(function (_z, rej) { setTimeout(function () { rej(new Error('wedged')); }, 4000); })
      ]).then(function () {}).catch(function () {
        try { win.webContents.reload(); } catch (e) {}
      });
    }, 600);
  });
}

app.whenReady().then(function () {
  try { app.setAppUserModelId('com.superbox.desktop'); } catch (e) {}
  logLine('INFO', 'app ready');

  if (proxyError) {
    showFatal('Streaming engine failed',
      'The embedded streaming engine (srv2.js) did not start. The UI will open, but playback will not work.',
      proxyError);
  }

  session.defaultSession.setPermissionRequestHandler(function (_wc, _perm, cb) { cb(true); });

  /* Accept any upstream certificate in the app window too: embedded player
     frames and provider pages with broken/expired chains must render instead
     of dying with a certificate-verification error. */
  try {
    session.defaultSession.setCertificateVerifyProc(function (_req, cb) { cb(0); });
  } catch (e) {}

  /* ONE listener (Electron keeps only the last attached per event). */
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, function (d, cb) {
    try {
      const u = String(d.url || '');
      if (!/\/jsd\//i.test(u) && /cloudflare|cdn-cgi/i.test(u) &&
          (/challenges\.cloudflare\.com\/cdn-cgi\//i.test(u) || /cdn-cgi\/challenge-platform\/h\//i.test(u) || /cf_chl_/i.test(u))) cfSniff(d, 'turnstile');
    } catch (e) {}
    cb({ cancel: isBlockedUrl(d.url) });
  });

  session.defaultSession.webRequest.onBeforeSendHeaders(function (d, cb) {
    try {
      d.requestHeaders['Accept-Language'] = 'en-US,en;q=0.9';
    } catch (e) {}
    cb({ requestHeaders: d.requestHeaders });
  });

  /* Framing fix: strip X-Frame-Options and CSP frame-ancestors from EVERY
     response. CRITICAL: every header set is rebuilt from scratch as arrays of
     clean non-empty strings - a header value that is empty or contains
     CR/LF/NUL fails Chromium's IPC validation and terminates the renderer
     with "bad IPC message". */
  session.defaultSession.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, function (d, cb) {
    try {
      const st = d.statusCode || 0;
      if (st === 403 || st === 503) {
        const hh = d.responseHeaders || {};
        let mit = '';
        Object.keys(hh).forEach(function (k) {
          const lk = k.toLowerCase();
          const v = Array.isArray(hh[k]) ? hh[k][0] : hh[k];
          if (lk === 'cf-mitigated') mit = String(v || '');
        });
        if (/challenge/i.test(mit)) cfSniff(d, 'hdr' + st);
      }
    } catch (e) {}
    const out = {};
    try {
      const h = d.responseHeaders || {};
      Object.keys(h).forEach(function (k) {
        let vals = h[k];
        if (vals == null) return;
        if (!Array.isArray(vals)) vals = [String(vals)];
        const lk = k.toLowerCase();
        if (lk === 'x-frame-options') return;              /* drop entirely */
        vals = vals.map(function (v) {
          v = String(v);
          if (lk === 'content-security-policy' || lk === 'content-security-policy-report-only') {
            v = v.replace(/frame-ancestors[^;]*(;|$)/gi, '').replace(/;;+/g, ';').trim();
          }
          return v.replace(/[\r\n\u0000]/g, '');
        }).filter(function (v) { return v.length > 0; });
        if (vals.length) out[k] = vals;
      });
    } catch (e) {
      return cb({});                                       /* unmodified on doubt */
    }
    cb({ responseHeaders: out });
  });

  /* Hotlink-protected media CDNs accept a file only when the Referer belongs
     to the site they serve for. Media elements played straight from this
     local page send ours (or none) - rewrite it for media traffic only. */
  const REF_FOR = [
    [/\.eporner\.com$|\.twinrdengine\.com$/i, 'https://www.eporner.com/'],
    [/\.hentaicity\.com$/i, 'https://www.hentaicity.com/'],
    [/\.1hanime\.com$|\.nhplayer\.com$/i, 'https://nhplayer.com/'],
    [/\.rule34video\.com$/i, 'https://rule34video.com/'],
    [/\.xbooru\.com$/i, 'https://xbooru.com/'],
    [/\.googlevideo\.com$/i, 'https://www.youtube.com/'],
    [/\.huangguo\.chat$|\.huangguodrama\.ai$/i, 'https://huangguodrama.ai/'],
    [/\.hakunaymatata\.com$/i, 'https://movieboxph.org/']
  ];
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, function (d, cb) {
    try {
      const u = d.url || '';
      const isMedia = d.resourceType === 'media' || /\.(mp4|webm|m4v|mov|ts|m4s|mpd|m3u8|key|bin)(\?|#|$)/i.test(u);
      if (isMedia && /^https?:/i.test(u) && !/^https?:\/\/(127\.0\.0\.1|127\.0\.0\.2|localhost)(:|\/)/i.test(u)) {
        const h = d.requestHeaders || {};
        const cur = h['Referer'] || h['referer'] || '';
        if (!cur || /(127\.0\.0\.1|127\.0\.0\.2|localhost|file:)/i.test(cur)) {
          let o = '';
          try {
            const m = new URL(u);
            for (let i = 0; i < REF_FOR.length; i++) {
              if (REF_FOR[i][0].test(m.hostname)) { o = REF_FOR[i][1]; break; }
            }
            if (!o) o = m.origin + '/';
          } catch (e) {}
          if (o) h['Referer'] = o;
          return cb({ requestHeaders: h });
        }
      }
    } catch (e) {}
    cb({});
  });

  /* Cloudflare clearance sync: after the browser itself solves a challenge,
     the cookies are pushed to the Node proxy so server-side grabs of the
     same host return real pages instead of a challenge. */
  const CK_HOSTS = [
    'hentaicity.com', 'hentai.tv', 'nhplayer.com',
    'kdramasmaza.net', 'katmoviehd.pk', 'xmaal.in', 'animixplay.la'
  ];
  function pushClearance() {
    CK_HOSTS.forEach(function (h) {
      try {
        session.defaultSession.cookies.get({ domain: h }).then(function (list) {
          if (!list || !list.length) return;
          const str = list.map(function (c) { return c.name + '=' + c.value; }).join('; ');
          fetch('http://127.0.0.1:46901/ck', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host: h, cookie: str })
          }).catch(function () {});
        }).catch(function () {});
      } catch (e) {}
    });
  }
  setTimeout(pushClearance, 9000);
  setInterval(pushClearance, 25000);

  createWindow();
}).catch(function (err) {
  showFatal('Startup failed', 'Electron could not finish its startup sequence.', err);
  app.quit();
});

ipcMain.handle('open-external', function (_e, url) { return shell.openExternal(url); });

/* Deny popups + external navigation for EVERY web contents ever created. */
app.on('web-contents-created', function (_event, contents) { hardenContents(contents); });

app.on('window-all-closed', function () { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', function () { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
