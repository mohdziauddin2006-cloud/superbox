/* reading.js - SuperBox Reading: a native manga / manhwa reader.
   ---------------------------------------------------------------------------
   Two sources expose a stable, public reading surface and therefore get a
   native reader:
     - MangaDex  (official JSON API + at-home page server)
     - WEBTOON   (official series + viewer pages)

   Everything else from source.txt opens in the in-app, VPN-routed browser via
   the Sources hub. The reader never talks to an origin directly: catalogue
   JSON and HTML ride /page, every page image rides /img (disk-cached by the
   local bridge). No account, no tracking, no external reader.

   Features: genre + age filters, search, continue-reading shelf, chapter
   list, lazy vertical page strip, next-page prefetch, per-chapter progress
   and keyboard navigation. Pure DOM; the host only supplies a mount element.
   --------------------------------------------------------------------------- */
(function () {
  'use strict';
  if (window.READER) return;

  var SC = window.SC || {};
  var enc = encodeURIComponent;
  var BASE = '';
  var root = null;
  var readerEl = null;
  var scrollSaveTimer = 0;
  var searchTimer = 0;

  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function text(el) { return el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : ''; }
  function stripHtml(v) {
    return String(v || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function lsGet(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function lsSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }
  function fmtDate(iso) {
    if (!iso) return '';
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (e) { return ''; }
  }
  function withTimeout(p, ms) {
    return Promise.race([p, new Promise(function (_z, rej) {
      setTimeout(function () { rej(new Error('timeout')); }, ms);
    })]);
  }
  function base() {
    if (BASE) return Promise.resolve(BASE);
    if (SC.base) return Promise.resolve(SC.base()).then(function (b) { BASE = b || ''; return BASE; });
    return Promise.resolve(location.origin || '');
  }

  /* ------------------------------------------------------------- transport */
  async function page(url, ms, signal) {
    var B = await base();
    var r = await withTimeout(fetch(B + '/page?url=' + enc(url), { cache: 'no-store', signal: signal }), ms || 26000);
    if (!r.ok) throw new Error('proxy HTTP ' + r.status);
    var body = await withTimeout(r.text(), ms || 26000);
    if (!body || body.indexOf('PROXY_ERROR') === 0 || body.length < 2) {
      throw new Error('source unavailable');
    }
    return body;
  }
  async function api(url, ms, signal) {
    var body = await page(url, ms, signal);
    try { return JSON.parse(body); } catch (e) { throw new Error('bad response from source'); }
  }
  /* Native Reading JSON bridge: reaches a reading provider's API with the
     headers it expects. The local server allowlists hosts and strips cookies,
     so this never becomes a general-purpose proxy. */
  async function readNet(url, opts) {
    opts = opts || {};
    var B = await base();
    var r = await withTimeout(fetch(withToken(B + '/reading/net'), {
      method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: url, method: opts.method || 'GET',
        headers: opts.headers || null, body: opts.body || ''
      })
    }), opts.ms || 30000);
    var raw = await withTimeout(r.text(), 30000);
    var j;
    try { j = JSON.parse(raw); } catch (e) { throw new Error('reading bridge returned no data'); }
    if (!j || j.ok === false) throw new Error((j && j.error) || ('source HTTP ' + (j && j.status)));
    return j;
  }
  function readNetJSON(url, opts) {
    return readNet(url, opts).then(function (j) {
      try { return JSON.parse(j.body || ''); } catch (e) { throw new Error('bad response from source'); }
    });
  }
  /* Signed, browser-computed XHR bodies (chapter pages / viewer manifests).
     The page runs in the app's own hidden, muted window; the body is handed
     straight back to this reader. */
  async function readCapture(url, match, want, cap) {
    var B = await base();
    var q = '/reading/capture?url=' + enc(url) + '&match=' + enc(match) + '&want=' + (want || 1) + '&cap=' + (cap || 26000);
    var r = await withTimeout(fetch(withToken(B + q), { cache: 'no-store' }), 48000);
    var raw = await withTimeout(r.text(), 48000);
    var j;
    try { j = JSON.parse(raw); } catch (e) { throw new Error('capture returned no data'); }
    if (!j || !j.ok || !j.bodies || !j.bodies.length) throw new Error((j && j.error) || 'no capture');
    return j.bodies.map(function (b) {
      var body = null;
      try { body = JSON.parse(b.body); } catch (e) {}
      return { url: b.url, status: b.status, body: body, raw: b.body };
    });
  }
  function jsonAttr(html, id) {
    var m = new RegExp('<script[^>]+id="' + id + '"[^>]*>([\\s\\S]*?)<\\/script>', 'i').exec(String(html || ''));
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch (e) { return null; }
  }
  function stripTags(v) {
    return String(v || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
  }
  function imgRef(url) {
    if (/mangadex|mangadex\.network|uploads\.mangadex/i.test(url)) return 'https://mangadex.org/';
    if (/pstatic\.net|webtoons\.com|naver/i.test(url)) return 'https://www.webtoons.com/';
    if (/tapas\.io/i.test(url)) return 'https://tapas.io/';
    return '';
  }
  function withToken(u) {
    try {
      var t = window.__SB_TOKEN__;
      if (t) return u + (u.indexOf('?') >= 0 ? '&' : '?') + 't=' + enc(t);
    } catch (e) {}
    return u;
  }
  /* MangaDex serves chapter pages from a per-region *.mangadex.network host,
     but the cover API still points at uploads.mangadex.org, which now answers
     with a browser-verification challenge. Learn the working host once from
     the at-home endpoint and rewrite cover URLs to it. */
  var mdCoverBasePromise = null;
  function mdCoverBase() {
    if (mdCoverBasePromise) return mdCoverBasePromise;
    mdCoverBasePromise = api('https://api.mangadex.org/at-home/server/eda848f0-279b-4e52-9160-d7e3002fc886')
      .then(function (j) {
        var b = j && j.baseUrl ? String(j.baseUrl) : '';
        if (b) { try { lsSet('sb.md.coverbase', b); } catch (e) {} }
        return b || 'https://cmdxd98sb0x3yprd.mangadex.network';
      })
      .catch(function () {
        var cached = '';
        try { cached = lsGet('sb.md.coverbase', ''); } catch (e) {}
        return cached || 'https://cmdxd98sb0x3yprd.mangadex.network';
      });
    return mdCoverBasePromise;
  }
  function mdCoverUrl(url) {
    if (!/uploads\.mangadex\.org\/covers\//i.test(url)) return url;
    var cached = '';
    try { cached = lsGet('sb.md.coverbase', ''); } catch (e) {}
    if (!cached) return url;
    return url.replace(/^https?:\/\/uploads\.mangadex\.org\//i, String(cached).replace(/\/$/, '') + '/');
  }
  function img(url, ref) {
    if (!url) return '';
    url = mdCoverUrl(url);
    if (!BASE) BASE = (location.protocol === 'http:' || location.protocol === 'https:') ? location.origin : '';
    if (!BASE) return url;
    var r = ref || imgRef(url);
    return withToken(BASE + '/img?u=' + enc(url) + (r ? '&ref=' + enc(r) : '') + '&cv=3');
  }

  /* -------------------------------------------------------------- md tags */
  var MD_TAGS = null;
  var MD_GENRES = [
    'Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy', 'Romance', 'Sci-Fi',
    'Slice of Life', 'Sports', 'Mystery', 'Horror', 'Supernatural', 'Thriller',
    'Historical', 'Isekai', 'Psychological', 'School Life', 'Mecha', 'Music'
  ];
  async function mdTags() {
    if (MD_TAGS) return MD_TAGS;
    var cache = lsGet('sb.read.md.tags', null);
    /* An empty cached list is a failed fetch, not a valid catalogue. Treating
       it as a hit hid every genre chip for a week after one bad request. */
    if (cache && Array.isArray(cache.v) && cache.v.length && cache.t && Date.now() - cache.t < 7 * 86400000) {
      MD_TAGS = cache.v;
      return MD_TAGS;
    }
    try {
      var j = await api('https://api.mangadex.org/manga/tag');
      var list = (j.data || []).map(function (t) {
        return { id: t.id, n: (t.attributes && t.attributes.name && t.attributes.name.en) || '' };
      }).filter(function (t) { return t.n; });
      MD_TAGS = list;
      lsSet('sb.read.md.tags', { t: Date.now(), v: list });
      return list;
    } catch (e) { return []; }
  }

  /* ---------------------------------------------------------------- state */
  var LANGUAGES = [
    { c: 'en', n: 'English' }, { c: 'es', n: 'Spanish' }, { c: 'fr', n: 'French' },
    { c: 'pt-br', n: 'Portuguese (BR)' }, { c: 'ru', n: 'Russian' }, { c: 'de', n: 'German' },
    { c: 'it', n: 'Italian' }, { c: 'pl', n: 'Polish' }, { c: 'tr', n: 'Turkish' },
    { c: 'id', n: 'Indonesian' }, { c: 'vi', n: 'Vietnamese' }, { c: 'th', n: 'Thai' },
    { c: 'ar', n: 'Arabic' }, { c: 'hi', n: 'Hindi' }, { c: 'ja', n: 'Japanese' },
    { c: 'ko', n: 'Korean' }, { c: 'zh', n: 'Chinese (Simplified)' }, { c: 'zh-hk', n: 'Chinese (Traditional)' },
    { c: 'uk', n: 'Ukrainian' }, { c: 'ro', n: 'Romanian' }, { c: 'cs', n: 'Czech' },
    { c: 'hu', n: 'Hungarian' }, { c: 'nl', n: 'Dutch' }, { c: 'sv', n: 'Swedish' },
    { c: 'fi', n: 'Finnish' }, { c: 'no', n: 'Norwegian' }, { c: 'da', n: 'Danish' },
    { c: 'el', n: 'Greek' }, { c: 'he', n: 'Hebrew' }, { c: 'bg', n: 'Bulgarian' },
    { c: 'ca', n: 'Catalan' }, { c: 'ms', n: 'Malay' }, { c: 'tl', n: 'Filipino' },
    { c: 'fa', n: 'Persian' }, { c: 'lt', n: 'Lithuanian' }, { c: 'lv', n: 'Latvian' },
    { c: 'et', n: 'Estonian' }, { c: 'sr', n: 'Serbian' }, { c: 'hr', n: 'Croatian' },
    { c: 'sk', n: 'Slovak' }, { c: 'sl', n: 'Slovenian' }, { c: 'af', n: 'Afrikaans' },
    { c: 'bn', n: 'Bengali' }, { c: 'bs', n: 'Bosnian' }
  ];
  var MD_TYPES = [
    { c: '', n: 'All types' }, { c: 'manga', n: 'Manga' },
    { c: 'manhwa', n: 'Manhwa' }, { c: 'manhua', n: 'Manhua' },
    { c: 'other', n: 'Other origin' }
  ];
  var WT_TYPES = [
    { c: '', n: 'All formats' }, { c: 'originals', n: 'Originals' }, { c: 'canvas', n: 'Canvas' }
  ];
  var MD_TYPE_LANGS = {
    manga: ['ja'],
    manhwa: ['ko'],
    manhua: ['zh', 'zh-hk'],
    other: ['id', 'th', 'vi', 'es', 'fr', 'de', 'pt-br', 'ru', 'it', 'ar', 'tr', 'pl', 'hi',
      'uk', 'ro', 'cs', 'hu', 'nl', 'sv', 'fi', 'no', 'da', 'el', 'he', 'bg', 'ca', 'ms', 'tl',
      'fa', 'lt', 'lv', 'et', 'sr', 'hr', 'sk', 'sl', 'af', 'bn', 'bs']
  };
  var WT_LOCALES = {
    en: 'en', es: 'es', fr: 'fr', 'pt-br': 'pt-br', ru: 'ru', de: 'de', it: 'it',
    id: 'id', th: 'th', zh: 'zh-hant', 'zh-hk': 'zh-hant', ja: 'ja',
    ar: 'ar', hi: 'hi', tr: 'tr', vi: 'vi'
  };

  var savedLang = lsGet('sb.read.lang', 'en');
  var savedType = lsGet('sb.read.type', '');
  var savedGenre = lsGet('sb.read.genre', '');
  var savedReaderMode = lsGet('sb.read.mode', 'webtoon');
  var savedFitMode = lsGet('sb.read.fit', 'width');
  var state = {
    adultMode: false,
    source: 'md',
    q: '',
    lang: LANGUAGES.some(function (l) { return l.c === savedLang; }) ? savedLang : 'en',
    type: typeof savedType === 'string' ? savedType : '',
    genre: typeof savedGenre === 'string' ? savedGenre : '',
    rating: 'safe',
    offset: 0,
    items: [],
    total: 0,
    loading: false,
    more: false,
    req: 0,
    ctl: null,
    view: 'browse',
    detail: null,
    wtPage: 1,
    tab: '',
    page: 1,
    readerMode: ['webtoon', 'single', 'spread'].indexOf(savedReaderMode) >= 0 ? savedReaderMode : 'webtoon',
    fitMode: ['width', 'height'].indexOf(savedFitMode) >= 0 ? savedFitMode : 'width',
    zoom: 100
  };
  var adultAdapters = {};
  function savePrefs() {
    lsSet('sb.read.lang', state.lang || 'en');
    lsSet('sb.read.type', state.type || '');
    lsSet('sb.read.genre', state.genre || '');
    lsSet('sb.read.mode', state.readerMode || 'webtoon');
    lsSet('sb.read.fit', state.fitMode || 'width');
  }
  state.type = typeForSource(state.type);
  function langLabel(code) {
    var hit = LANGUAGES.filter(function (l) { return l.c === code; })[0];
    return hit ? hit.n : (code || 'English');
  }
  function typeLabel(code) {
    var hit = MD_TYPES.concat(WT_TYPES).filter(function (t) { return t.c === code; })[0];
    return hit ? hit.n : '';
  }
  function mdTypeOf(orig) {
    if (orig === 'ja') return 'manga';
    if (orig === 'ko') return 'manhwa';
    if (orig === 'zh' || orig === 'zh-hk') return 'manhua';
    return 'other';
  }
  function wtLocale() {
    return WT_LOCALES[state.lang] || 'en';
  }
  function typesForSource() {
    if (state.source === 'md') return MD_TYPES;
    if (state.source === 'wt') return WT_TYPES;
    return [{ c: '', n: 'All' }];
  }
  function typeForSource(code) {
    var allowed = state.source === 'md' ? ['', 'manga', 'manhwa', 'manhua', 'other']
      : state.source === 'wt' ? ['', 'originals', 'canvas'] : [''];
    return allowed.indexOf(code) >= 0 ? code : '';
  }
  function reloadSource() {
    if (state.adultMode && adultAdapters[state.source] && typeof adultAdapters[state.source].catalog === 'function') {
      return runCustomAdultAdapter(state.source);
    }
    if (state.source === 'md') mdLoad(false);
    else if (state.source === 'wt') wtLoad();
    else nativeLoad(false);
  }
  async function runCustomAdultAdapter(srcId) {
    var req = ++state.req;
    state.loading = true;
    state.items = [];
    paintBody();
    try {
      var list = await adultAdapters[srcId].catalog(state.q || '');
      if (req !== state.req) return;
      state.items = Array.isArray(list) ? list : [];
      state.total = state.items.length;
      state.more = false;
    } catch (e) {
      if (req !== state.req) return;
      state.items = [];
      state.total = 0;
    }
    state.loading = false;
    paintBody();
  }

  var WT_GENRES = [
    { s: 'action', n: 'Action' }, { s: 'romance', n: 'Romance' }, { s: 'fantasy', n: 'Fantasy' },
    { s: 'comedy', n: 'Comedy' }, { s: 'drama', n: 'Drama' }, { s: 'thriller', n: 'Thriller' },
    { s: 'slice-of-life', n: 'Slice of Life' }, { s: 'sports', n: 'Sports' }, { s: 'sci-fi', n: 'Sci-Fi' },
    { s: 'mystery', n: 'Mystery' }, { s: 'historical', n: 'Historical' },
    { s: 'heartwarming', n: 'Heartwarming' }, { s: 'horror', n: 'Horror' },
    { s: 'supernatural', n: 'Supernatural' }, { s: 'school', n: 'School' }
  ];

  function isAdultSourceId(id) {
    if (id === 'hentai20' || id === 'nhentai') return true;
    var p = providerById(id);
    return !!(p && p.adult);
  }
  function ratingAllowed(item) {
    if (!item) return false;
    if (state.adultMode) return true;
    if (item.adult || isAdultSourceId(item.source)) return false;
    if (item.rating === 'erotica' || item.rating === 'pornographic') return false;
    if (state.rating === 'safe' && item.rating === 'suggestive') return false;
    return true;
  }
  function ratingPairs() {
    if (state.adultMode) return ['erotica', 'pornographic'];
    if (state.rating === 'safe') return ['safe'];
    return ['safe', 'suggestive'];
  }
  function qs(pairs) {
    return pairs.map(function (p) { return p[0] + '=' + enc(p[1]); }).join('&');
  }

  /* -------------------------------------------------------------- history */
  function history() {
    var list = lsGet('sb.read.history', []);
    if (!Array.isArray(list)) return [];
    return list.filter(function (h) {
      var adult = !!(h && (h.adult || isAdultSourceId(h.source)));
      return state.adultMode ? adult : !adult;
    });
  }
  function remember(entry) {
    if (!entry || !entry.id) return;
    var list = history().filter(function (h) { return !(h.source === entry.source && h.id === entry.id); });
    list.unshift(entry);
    lsSet('sb.read.history', list.slice(0, 16));
  }
  function progressOf(source, id) {
    return lsGet('sb.read.progress.' + source + '.' + id, null);
  }
  function saveProgress(entry) {
    if (!entry) return;
    lsSet('sb.read.progress.' + entry.source + '.' + entry.id, {
      chapterId: entry.chapterId || '', chapterLabel: entry.chapterLabel || '',
      ep: entry.ep || 0, page: entry.page || 0, at: Date.now()
    });
    remember(entry);
  }
  function readPosKey(source, chapterId) {
    return 'sb.read.pos.' + source + '.' + (chapterId || '');
  }

  /* ------------------------------------------------------------ MangaDex */
  function mdTitle(a) {
    var t = (a && a.title) || {};
    return t.en || t['ja-ro'] || t.ja || t.ko || t.zh || t['zh-hk'] || Object.keys(t).map(function (k) { return t[k]; })[0] || 'Untitled';
  }
  function mdDesc(a) {
    var d = (a && a.description) || {};
    return stripHtml(d.en || d['ja-ro'] || d.ja || Object.keys(d).map(function (k) { return d[k]; })[0] || '');
  }
  function mdCard(d) {
    var a = d.attributes || {};
    var cover = '', author = '';
    (d.relationships || []).forEach(function (r) {
      if (r.type === 'cover_art' && r.attributes && r.attributes.fileName) cover = r.attributes.fileName;
      if (r.type === 'author' && r.attributes && r.attributes.name) author = r.attributes.name;
    });
    return {
      source: 'md',
      id: d.id,
      title: mdTitle(a),
      cover: cover ? 'https://uploads.mangadex.org/covers/' + d.id + '/' + cover + '.512.jpg' : '',
      desc: mdDesc(a),
      year: a.year || '',
      status: a.status || '',
      tags: (a.tags || []).map(function (t) {
        return (t.attributes && t.attributes.name && t.attributes.name.en) || '';
      }).filter(Boolean),
      author: author,
      orig: a.originalLanguage || '',
      rating: a.contentRating || ''
    };
  }
  async function mdLoad(append) {
    var req = ++state.req;
    /* Cancel the previous download when filters change quickly. Without this a
       stale 450 KB payload keeps the tunnel busy and the newest filter waits
       behind it until its own timeout. */
    if (state.ctl) { try { state.ctl.abort(); } catch (e) {} }
    var ctl = new AbortController();
    state.ctl = ctl;
    if (!append) { state.offset = 0; state.items = []; }
    state.loading = true;
    state.more = false;
    paintBody();
    var tagId = '';
    if (state.genre) {
      var tags = await mdTags();
      if (req !== state.req) return;
      var hit = tags.filter(function (t) { return t.n.toLowerCase() === state.genre.toLowerCase(); })[0];
      tagId = hit ? hit.id : '';
    }
    var pairs = [
      ['limit', '24'],
      ['offset', String(state.offset)],
      ['includes[]', 'cover_art'],
      ['includes[]', 'author'],
      ['hasAvailableChapters', 'true'],
      ['availableTranslatedLanguage[]', state.lang || 'en']
    ];
    if (state.q) { pairs.push(['title', state.q]); pairs.push(['order[relevance]', 'desc']); }
    else pairs.push(['order[followedCount]', 'desc']);
    if (tagId) pairs.push(['includedTags[]', tagId]);
    var typeLangs = MD_TYPE_LANGS[state.type];
    if (typeLangs) typeLangs.forEach(function (l) { pairs.push(['originalLanguage[]', l]); });
    ratingPairs().forEach(function (r) { pairs.push(['contentRating[]', r]); });
    try {
      var j = null;
      /* MangaDex rate-limits bursts; one quiet retry keeps the shelf full. */
      for (var attempt = 0; attempt < 2; attempt++) {
        try {
          j = await api('https://api.mangadex.org/manga?' + qs(pairs), 40000, ctl.signal);
          break;
        } catch (err) {
          if (attempt === 1) throw err;
          await new Promise(function (r) { setTimeout(r, 1400); });
        }
      }
      if (req !== state.req) return;
      var list = (j.data || []).map(mdCard).filter(function (it) {
        if (!ratingAllowed(it)) return false;
        return !state.type || mdTypeOf(it.orig) === state.type;
      });
      state.items = append ? state.items.concat(list) : list;
      state.offset += (j.data || []).length;
      state.total = Number(j.total) || state.items.length;
      state.more = state.offset < state.total && (j.data || []).length > 0;
    } catch (e) {
      if (req !== state.req) return;
      if (!append) state.items = [];
      state.total = 0;
      state.more = false;
      if (e && e.name === 'AbortError') return;
      toast(e.message || 'MangaDex is unavailable');
    }
    state.loading = false;
    paintBody();
    if (!append) {
      mdCoverBase().then(function () {
        if (req === state.req && state.source === 'md' && state.view === 'browse' && root) paintBody();
      });
    }
  }

  function mdFeed(manga, offset, append) {
    var lang = state.lang || 'en';
    var pairs = [
      ['limit', '500'],
      ['offset', String(offset || 0)],
      ['order[chapter]', 'desc'],
      ['translatedLanguage[]', lang],
      ['includeExternalUrl', '0'],
      ['includes[]', 'scanlation_group']
    ];
    /* Strict language contract: no cross-language fallback, no external
       official links. A blank feed means "no English chapters", which the
       detail page states plainly instead of quietly showing Japanese. */
    return api('https://api.mangadex.org/manga/' + manga.id + '/feed?' + qs(pairs)).then(function (j) {
      var list = (j.data || []).map(function (c) {
        var a = c.attributes || {};
        var group = '';
        (c.relationships || []).forEach(function (r) {
          if (r.type === 'scanlation_group' && r.attributes) group = r.attributes.name || '';
        });
        return {
          id: c.id,
          chapter: a.chapter || '',
          title: a.title || '',
          pages: a.pages || 0,
          lang: a.translatedLanguage || '',
          date: a.publishAt || '',
          group: group
        };
      }).filter(function (c) {
        return c.pages > 0 && String(c.lang).toLowerCase() === lang.toLowerCase();
      });
      if (append) manga.chapters = (manga.chapters || []).concat(list);
      else manga.chapters = list;
      manga.feedOffset = (offset || 0) + (j.data || []).length;
      manga.feedTotal = Number(j.total) || manga.chapters.length;
      manga.emptyFeed = !manga.chapters.length;
      manga.feedLang = lang;
      return manga;
    });
  }

  /* -------------------------------------------------------------- WEBTOON */
  function parseWtCards(html, seriesBase) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var out = [];
    var seen = {};
    $$('a[data-title-no]', doc).forEach(function (a) {
      var href = a.getAttribute('href') || '';
      if (!/\/list\?/.test(href)) return;
      var id = a.getAttribute('data-title-no') || '';
      if (!id || seen[id]) return;
      var img = a.querySelector('img');
      var wrap = a.querySelector('.image_wrap');
      var adult = !!(wrap && wrap.getAttribute('data-title-unsuitable-for-children') === 'true');
      var title = text(a.querySelector('.title') || a.querySelector('.subj'));
      if (!title) return;
      seen[id] = 1;
      out.push({
        source: 'wt',
        id: id,
        title: title,
        cover: img ? (img.getAttribute('src') || img.getAttribute('data-src') || '') : '',
        author: text(a.querySelector('.author')),
        genre: text(a.querySelector('.genre')),
        desc: '',
        tags: [],
        adult: adult,
        url: href.charAt(0) === '/' ? 'https://www.webtoons.com' + href : href
      });
    });
    return out;
  }
  function wtBrowseUrl() {
    var loc = wtLocale();
    if (state.q) return 'https://www.webtoons.com/' + loc + '/search?keyword=' + enc(state.q);
    if (state.genre) return 'https://www.webtoons.com/' + loc + '/genres/' + state.genre + '?sortOrder=UPDATE';
    if (state.type === 'canvas') return 'https://www.webtoons.com/' + loc + '/canvas?sortOrder=UPDATE';
    return 'https://www.webtoons.com/' + loc + '/originals?sortOrder=UPDATE';
  }
  async function wtLoad() {
    var req = ++state.req;
    if (state.ctl) { try { state.ctl.abort(); } catch (e) {} }
    var ctl = new AbortController();
    state.ctl = ctl;
    state.loading = true;
    state.more = false;
    paintBody();
    if (state.lang !== 'en' && !WT_LOCALES[state.lang]) {
      toast('WEBTOON has no ' + langLabel(state.lang) + ' catalogue; showing English titles.');
    }
    try {
      var html = await page(wtBrowseUrl(), 28000, ctl.signal);
      if (req !== state.req) return;
      var list = parseWtCards(html).filter(ratingAllowed).slice(0, 30);
      state.items = list;
      state.total = list.length;
      state.more = false;
    } catch (e) {
      if (req !== state.req) return;
      if (e && e.name === 'AbortError') return;
      state.items = [];
      toast('WEBTOON is unavailable');
    }
    state.loading = false;
    paintBody();
  }

  function wtSeriesUrlFrom(seriesUrl, ep) {
    try {
      var u = new URL(seriesUrl);
      u.pathname = u.pathname.replace(/\/list\/?$/, '/episode-' + ep + '/viewer');
      u.searchParams.set('episode_no', String(ep));
      return u.toString();
    } catch (e) {
      return seriesUrl.replace(/\/list(\?|$)/, '/episode-' + ep + '/viewer$1');
    }
  }
  function parseWtSeries(html, seriesUrl) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var meta = function (sel) { return text(doc.querySelector(sel)); };
    var og = doc.querySelector('meta[property="og:image"]');
    var coverEl = doc.querySelector('.detail_header .thmb img') || doc.querySelector('.thmb img');
    var title = meta('.detail_header .subj') || meta('h1.subj') || meta('h3.subj') || text(doc.querySelector('title'));
    title = title.replace(/\s*-\s*WEBTOON\s*$/i, '').trim();
    var series = {
      source: 'wt',
      id: '',
      title: title,
      author: meta('.detail_header .author') || meta('.author'),
      genre: meta('.detail_header .genre') || meta('.genre'),
      desc: meta('.summary') || meta('#summary') || '',
      cover: (coverEl && (coverEl.getAttribute('src') || coverEl.getAttribute('data-src'))) ||
        (og && og.getAttribute('content')) || '',
      url: seriesUrl,
      episodes: []
    };
    try { series.id = new URL(seriesUrl).searchParams.get('title_no') || ''; } catch (e) {}
    var seen = {};
    $$('._episodeItem', doc).forEach(function (li) {
      var a = li.querySelector('a.detail_list_link') || li.querySelector('a');
      if (!a) return;
      var href = a.getAttribute('href') || '';
      if (!href) return;
      var no = parseInt(li.getAttribute('data-episode-no') || '', 10);
      if (!no) {
        var m = /episode[-_]?(\d+)/i.exec(href);
        no = m ? parseInt(m[1], 10) : 0;
      }
      if (!no || seen[no]) return;
      seen[no] = 1;
      series.episodes.push({
        no: no,
        title: text(a.querySelector('.subj')) || ('Episode ' + no),
        date: text(a.querySelector('.date')),
        url: href.charAt(0) === '/' ? 'https://www.webtoons.com' + href : href
      });
    });
    series.more = series.episodes.length >= 10;
    series.page = 1;
    return series;
  }
  async function wtSeries(seriesUrl) {
    var html = await page(seriesUrl, 28000);
    return parseWtSeries(html, seriesUrl);
  }
  async function wtMoreEpisodes(series) {
    var next = (series.page || 1) + 1;
    var u;
    try {
      u = new URL(series.url);
      u.searchParams.set('page', String(next));
    } catch (e) { return; }
    var html = await page(u.toString(), 28000);
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var seen = {};
    series.episodes.forEach(function (e) { seen[e.no] = 1; });
    var added = 0;
    $$('._episodeItem', doc).forEach(function (li) {
      var a = li.querySelector('a.detail_list_link') || li.querySelector('a');
      if (!a) return;
      var no = parseInt(li.getAttribute('data-episode-no') || '', 10);
      if (!no) {
        var m = /episode[-_]?(\d+)/i.exec(a.getAttribute('href') || '');
        no = m ? parseInt(m[1], 10) : 0;
      }
      if (!no || seen[no]) return;
      seen[no] = 1;
      series.episodes.push({
        no: no,
        title: text(a.querySelector('.subj')) || ('Episode ' + no),
        date: text(a.querySelector('.date')),
        url: (a.getAttribute('href') || '').charAt(0) === '/' ? 'https://www.webtoons.com' + a.getAttribute('href') : a.getAttribute('href')
      });
      added++;
    });
    series.page = next;
    series.more = added >= 10;
    return series;
  }

  /* ------------------------------------------------------- native providers
     Every reading provider named in source.txt gets a native adapter: the
     catalogue, series metadata and chapter page strip are fetched by SuperBox,
     not handed to an external browser. Server-rendered sites ride /page;
     JavaScript-heavy sites are rendered by the app's own hidden, muted window
     (/render) because their HTML shells contain no cards or pages. Chapter
     images always ride the local /img cache with the provider's Referer. */
  async function hiveCatalog(q) {
    /* HiveToons' search route renders an empty archive for most queries even
       when the title exists; the unfiltered /series archive is complete. */
    var snap = await renderSnap('https://hivetoons.org/series', 'catalog');
    var out = [], seen = {};
    (snap.anchors || []).forEach(function (a) {
      var u = String(a.h || '').replace(/[?#].*$/, '').replace(/\/+$/, '');
      if (!/^https:\/\/hivetoons\.org\/series\/[^/?#]+$/i.test(u)) return;
      if (seen[u]) return;
      var title = cleanTitle(a.a || '');
      if (!title || /^(read series|series|browse|home)$/i.test(title)) return;
      seen[u] = 1;
      out.push({
        source: 'hive', id: slugOf(u), title: title, cover: a.i || '',
        url: u, ref: 'https://hivetoons.org/', adult: false
      });
    });
    if (q) {
      var needle = q.toLowerCase();
      out = out.filter(function (x) { return x.title.toLowerCase().indexOf(needle) >= 0; });
    }
    return out.slice(0, 48);
  }
  function comixSlugTitle(u) {
    var m = /\/title\/([^/?#]+)/i.exec(String(u || ''));
    if (!m) return '';
    var slug = m[1].replace(/^[a-z0-9]{4,6}-/i, '').replace(/-+/g, ' ').replace(/\s+/g, ' ').trim();
    return cleanTitle(slug.replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); }));
  }
  async function comixCatalog(q) {    var url = q ? 'https://comix.to/browse?q=' + enc(q) : 'https://comix.to/';
    var snap = await renderSnap(url, 'catalog');
    var out = [], seen = {};
    (snap.anchors || []).forEach(function (a) {
      var u = String(a.h || '').replace(/[?#].*$/, '');
      if (!/^https:\/\/comix\.to\/title\/[^/?#]+$/i.test(u)) return;
      if (seen[u]) return;
      seen[u] = 1;
      var title = cleanTitle(a.a || '') || comixSlugTitle(u);
      if (!title) return;
      out.push({
        source: 'comix', id: slugOf(u), title: title, cover: a.i || '',
        url: u, ref: 'https://comix.to/', adult: false
      });
    });
    if (q) {
      var needle = q.toLowerCase();
      out = out.filter(function (x) { return x.title.toLowerCase().indexOf(needle) >= 0; });
    }
    return out.slice(0, 48);
  }

  /* ------------------------------------------------- adult reading adapters
     Hentai20 is a Madara/mangareader theme. Its catalogue is server-rendered
     (data-src, data-lazy-src and srcset covers), its detail page carries the
     complete #chapterlist, and every chapter embeds an ordered ts_reader.run
     JSON page list. We use those three native surfaces directly instead of
     scraping the rendered viewport, so pagination and every page survive. */
  function lazyImg(im) {
    if (!im) return '';
    var attrs = ['data-src', 'data-lazy-src', 'data-original', 'data-url', 'src', 'data-cfsrc'];
    for (var i = 0; i < attrs.length; i++) {
      var v = im.getAttribute(attrs[i]);
      if (v && !/^data:/i.test(v) && !/\/(blank|placeholder|spacer|loading|transparent)/i.test(v)) return v;
    }
    var ss = im.getAttribute('srcset') || im.getAttribute('data-srcset') || '';
    if (ss) {
      var parts = ss.split(',').map(function (x) { return x.trim().split(/\s+/)[0]; }).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
    return '';
  }
  function absoluteUrl(raw, baseUrl) {
    try { return new URL(String(raw || ''), baseUrl).toString(); } catch (e) { return ''; }
  }
  function h20Doc(html) {
    try { return new DOMParser().parseFromString(String(html || ''), 'text/html'); } catch (e) { return null; }
  }
  function h20PageUrl(opts) {
    var page = Math.max(1, parseInt(opts.page, 10) || 1);
    if (opts.q) return page === 1
      ? 'https://hentai20.io/?s=' + enc(opts.q)
      : 'https://hentai20.io/page/' + page + '/?s=' + enc(opts.q);
    if (opts.genre) return 'https://hentai20.io/genres/' + opts.genre + '/' + (page > 1 ? 'page/' + page + '/' : '');
    var tab = opts.tab === 'popular' || opts.tab === 'trending' ? opts.tab : 'latest';
    if (tab === 'latest') return 'https://hentai20.io/home1/' + (page > 1 ? 'page/' + page + '/' : '');
    return 'https://hentai20.io/manga/?status=&type=&order=' + tab + (page > 1 ? '&page=' + page : '');
  }
  async function hentai20Catalog(opts) {
    opts = opts || {};
    var url = h20PageUrl(opts);
    var j = await readNet(url, { ms: 30000 });
    var doc = h20Doc(j.body);
    if (!doc) throw new Error('Hentai20 returned no catalogue');
    var out = [], seen = {};
    Array.prototype.forEach.call(doc.querySelectorAll('a[href*="/manga/"]'), function (a) {
      var u = absoluteUrl(a.getAttribute('href'), url).replace(/[?#].*$/, '');
      if (!/^https:\/\/hentai20\.io\/manga\/[^/?#]+\/?$/i.test(u)) return;
      if (seen[u]) return;
      var card = a.closest('.bs, .bsx, .utao, .listupd li') || a.parentElement;
      var im = a.querySelector('img') || (card && card.querySelector('img'));
      var title = cleanTitle(a.getAttribute('title') || a.textContent || (im && im.getAttribute('alt')) || '');
      if (!title) return;
      seen[u] = 1;
      out.push({
        source: 'hentai20', id: slugOf(u), title: title,
        cover: absoluteUrl(lazyImg(im), url), url: u,
        ref: 'https://hentai20.io/', adult: true
      });
    });
    var next = doc.querySelector('link[rel="next"], a.next.page-numbers, .pagination a.next');
    return { items: out, more: !!next && out.length > 0 };
  }
  async function hentai20Detail(item) {
    var html = await page(item.url, 30000);
    var doc = h20Doc(html);
    if (!doc) throw new Error('Hentai20 returned no title');
    var title = cleanTitle((doc.querySelector('.entry-title, .seriestuheader h1, h1') || {}).textContent || item.title);
    var coverIm = doc.querySelector('.seriestucontl .thumb img, .thumb img, .summary_image img');
    var cover = absoluteUrl(lazyImg(coverIm), item.url);
    if (!cover) {
      var og = doc.querySelector('meta[property="og:image"]');
      cover = og ? absoluteUrl(og.getAttribute('content'), item.url) : '';
    }
    var descEl = doc.querySelector('.summary__content, .summary_content, .seriestucontent .entry-content, .description-summary');
    var desc = descEl ? stripTags(descEl.textContent).slice(0, 1200) : '';
    if (!desc) {
      var meta = doc.querySelector('meta[name="description"]');
      desc = meta ? stripTags(meta.getAttribute('content')).slice(0, 900) : '';
    }
    var tags = [];
    Array.prototype.forEach.call(doc.querySelectorAll('.seriestugenre a, .genres a'), function (a) {
      var t = stripTags(a.textContent);
      if (t && tags.indexOf(t) < 0 && tags.length < 12) tags.push(t);
    });
    var chapters = [], seen = {};
    function pushChapter(u, label, no) {
      u = absoluteUrl(u, item.url).replace(/#.*$/, '');
      if (!u || !/^https:\/\/hentai20\.io\/[^/?#]+-chapter-[\d.]+\/?$/i.test(u)) return;
      if (seen[u]) return;
      var lb = cleanTitle(label || ('Chapter ' + (no || '')));
      if (!lb || nonEnglishLabel(lb)) return;
      seen[u] = 1;
      var n = parseFloat(no);
      if (!isFinite(n)) n = chapterNoOf(lb, u);
      chapters.push({ id: u, url: u, title: lb, no: n, lang: 'en' });
    }
    Array.prototype.forEach.call(doc.querySelectorAll('#chapterlist li'), function (li) {
      var a = li.querySelector('a[href]');
      if (!a) return;
      var label = (li.querySelector('.chapternum') || a).textContent || '';
      pushChapter(a.getAttribute('href'), label, li.getAttribute('data-num'));
    });
    if (!chapters.length) {
      Array.prototype.forEach.call(doc.querySelectorAll('a[href*="-chapter-"]'), function (a) {
        pushChapter(a.getAttribute('href'), a.textContent, '');
      });
    }
    if (!chapters.length) {
      /* Madara keeps the complete list behind admin-ajax on some skins. The
         series id is the article id printed on the detail page. */
      var art = doc.querySelector('article[id^="post-"], [id^="post-"]');
      var mid = art ? (String(art.id).match(/post-(\d+)/) || [])[1] : '';
      if (mid) {
        try {
          var aj = await readNet('https://hentai20.io/wp-admin/admin-ajax.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
            body: 'action=manga_get_chapters&manga=' + enc(mid), ms: 30000
          });
          var adoc = h20Doc(aj.body);
          if (adoc) {
            Array.prototype.forEach.call(adoc.querySelectorAll('li'), function (li) {
              var a = li.querySelector('a[href]');
              if (a) pushChapter(a.getAttribute('href'), (li.querySelector('.chapternum') || a).textContent, li.getAttribute('data-num'));
            });
          }
        } catch (e) {}
      }
    }
    chapters.sort(function (x, y) { return (x.no - y.no) || String(x.url).localeCompare(String(y.url)); });
    if (!chapters.length) throw new Error('Hentai20 returned no English chapters');
    return {
      source: 'hentai20', id: item.id || slugOf(item.url),
      title: title || item.title, cover: cover || item.cover || '',
      desc: desc, author: 'Hentai20', genre: '', tags: tags,
      url: item.url, ref: 'https://hentai20.io/', chapters: chapters,
      more: false, chapterMode: 'native'
    };
  }
  function h20ReaderJSON(html) {
    var m = /ts_reader\.run\((\{[\s\S]*?\})\)\s*;/i.exec(String(html || ''));
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch (e) { return null; }
  }
  async function hentai20Chapter(_detail, chapter) {
    var html = await page(chapter.url, 30000);
    var urls = [], seen = {};
    function add(raw) {
      var u = absoluteUrl(String(raw || '').replace(/\\\//g, '/'), chapter.url).replace(/^http:/i, 'https:');
      if (!u || seen[u] || !/^https:\/\/img\.hentai1\.io\/.+\/chapter-[^/]+\/.+\.(?:jpe?g|png|webp)$/i.test(u)) return;
      seen[u] = 1;
      urls.push(u);
    }
    var data = h20ReaderJSON(html);
    if (data && data.sources && data.sources.length) {
      /* Multiple "servers" repeat the same chapter on different CDNs. Use the
         single most complete source so pages cannot interleave or duplicate. */
      var best = null;
      data.sources.forEach(function (src) {
        var n = (src && src.images) ? src.images.length : 0;
        if (n && (!best || n > best.length)) best = src.images;
      });
      if (best) best.forEach(add);
    }
    if (!urls.length) {
      var doc = h20Doc(html);
      var scope = doc && doc.querySelector('.reading-content, #readerarea, .page-break, .entry-content');
      var imgs = scope ? scope.querySelectorAll('img') : (doc ? doc.querySelectorAll('img') : []);
      Array.prototype.forEach.call(imgs, function (im) { add(lazyImg(im)); });
    }
    if (!urls.length) throw new Error('Hentai20 returned no pages');
    return urls;
  }

  /* --------------------------------------------------------- nhentai.net
     Official v2 JSON API (the old /api/galleries endpoints now answer 403 and
     point here). Search is always scoped to language:english and every list
     row is verified against the English language tag (id 12227) instead of
     trusting the query alone. A hidden-renderer fallback covers Cloudflare. */
  var NH_API = 'https://nhentai.net/api/v2';
  var NH_UA = 'SuperBox/1.3.1 (+https://github.com/mohdziauddin2006-cloud/superbox)';
  var NH_EN = 12227;
  var NH_CACHE = {};
  function nhHeaders(extra) {
    var h = { 'User-Agent': NH_UA, 'Accept': 'application/json' };
    if (extra) Object.keys(extra).forEach(function (k) { h[k] = extra[k]; });
    return h;
  }
  async function nhJSON(path) {
    var j = await readNetJSON(NH_API + path, { headers: nhHeaders(), ms: 30000 });
    if (j && j.ok === false) throw new Error(j.error || 'nhentai unavailable');
    return j;
  }
  function nhCleanPath(p) {
    return String(p || '').replace(/\.(webp|jpg|jpeg|png)\.\1$/i, '.$1');
  }
  function nhItem(g) {
    var thumb = String(g.thumbnail || '');
    if (!thumb && g.media_id) thumb = 'galleries/' + g.media_id + '/thumb.webp';
    return {
      source: 'nhentai', id: String(g.id),
      title: cleanTitle(g.english_title || g.japanese_title || g.pretty_title || '') || 'Untitled',
      cover: thumb ? 'https://t.nhentai.net/' + nhCleanPath(thumb) : '',
      url: 'https://nhentai.net/g/' + g.id + '/',
      ref: 'https://nhentai.net/', adult: true,
      pages: Number(g.num_pages) || 0,
      tags: (g.tags || []).map(function (t) { return t.name || ''; }).filter(Boolean).slice(0, 8)
    };
  }
  function nhEnglish(g) {
    if (g && g.tags) {
      return g.tags.some(function (t) { return t && t.type === 'language' && /^english$/i.test(String(t.name || '')); });
    }
    var ids = (g && g.tag_ids) || [];
    return ids.indexOf(NH_EN) >= 0;
  }
  function nhList(j) {
    if (!j) return { list: [], more: false };
    if (Array.isArray(j)) return { list: j, more: false };
    return { list: j.result || j.galleries || [], more: !!j.num_pages && Number(j.page || 1) < Number(j.num_pages) };
  }
  async function nhRenderCatalog(url, page) {
    var snap = await renderSnap(url, 'catalog');
    var out = [], seen = {};
    (snap.anchors || []).forEach(function (a) {
      var u = String(a.h || '').replace(/[?#].*$/, '');
      if (!/^https:\/\/nhentai\.net\/g\/\d+\/?$/i.test(u)) return;
      if (seen[u]) return;
      seen[u] = 1;
      var title = cleanTitle(a.t || a.a || '');
      if (!title) return;
      out.push({
        source: 'nhentai', id: (u.match(/\/g\/(\d+)/) || [])[1] || slugOf(u),
        title: title, cover: a.i || '', url: u,
        ref: 'https://nhentai.net/', adult: true
      });
    });
    var more = false;
    try {
      var doc = new DOMParser().parseFromString(String(snap.html || ''), 'text/html');
      more = !!(doc.querySelector('a[rel="next"], .pagination a.next, a.next'));
    } catch (e) {}
    return { items: out, more: more };
  }
  async function nhentaiCatalog(opts) {
    opts = opts || {};
    var page = Math.max(1, parseInt(opts.page, 10) || 1);
    var tab = opts.tab === 'recent' ? 'recent' : 'popular';
    var q = String(opts.q || '').trim();
    var genre = String(opts.genre || '').trim();
    try {
      /* Search is the only v2 surface that paginates reliably. Scoping every
         catalogue to language:english keeps Popular and Recent fully English
         (the plain /galleries feed mixes every language and would leave most
         pages empty after verification). */
      var query = 'language:english' + (q ? ' ' + q : '') + (genre ? ' tag:"' + genre + '"' : '');
      var sort = (q || genre) ? 'popular' : (tab === 'recent' ? 'date' : 'popular');
      var j = await nhJSON('/search?query=' + enc(query) + '&page=' + page + '&sort=' + sort);
      var got = nhList(j);
      got.more = page < Number(j.num_pages || 0);
      var verified = got.list.filter(nhEnglish).map(nhItem);
      return { items: verified, more: got.more };
    } catch (e) {
      /* Cloudflare / 403 fallback: render the public HTML in the hidden,
         muted window and read the same anchors. */
      var htmlUrl;
      if (q || genre) {
        htmlUrl = 'https://nhentai.net/search/?q=' + enc(('language:english ' + (q || '') + (genre ? ' tag:"' + genre + '"' : '')).trim()) + '&sort=popular' + (page > 1 ? '&page=' + page : '');
      } else if (tab === 'recent') {
        htmlUrl = 'https://nhentai.net/' + (page > 1 ? '?page=' + page : '');
      } else {
        htmlUrl = 'https://nhentai.net/';
      }
      return await nhRenderCatalog(htmlUrl, page);
    }
  }
  async function nhentaiDetail(item) {
    var id = String(item.id || '').replace(/\D+/g, '');
    if (!id) id = (String(item.url).match(/\/g\/(\d+)/) || [])[1] || '';
    if (!id) throw new Error('nhentai title missing');
    var d = NH_CACHE[id];
    if (!d || Date.now() - d.t > 600000) {
      var g = null;
      try {
        g = await nhJSON('/galleries/' + id);
      } catch (e) {
        /* Rendered fallback below. */
      }
      if (g && g.id) {
        if (!nhEnglish(g)) throw new Error('nhentai title is not English');
        var pages = (g.pages || []).map(function (p) { return nhCleanPath(p.path); }).filter(Boolean);
        var coverPath = nhCleanPath((g.cover && g.cover.path) || (g.thumbnail && g.thumbnail.path) || '');
        d = {
          g: g, pages: pages, t: Date.now(),
          title: cleanTitle((g.title && (g.title.english || g.title.pretty || g.title.japanese)) || '') || item.title,
          cover: coverPath ? 'https://t.nhentai.net/' + coverPath : (item.cover || ''),
          tags: (g.tags || []).filter(function (t) { return t.type === 'tag' || t.type === 'artist' || t.type === 'group'; })
            .map(function (t) { return t.name; }).filter(Boolean).slice(0, 12),
          desc: ''
        };
        NH_CACHE[id] = d;
      } else {
        var snap = await renderSnap(item.url, 'detail');
        var doc = new DOMParser().parseFromString(String(snap.html || ''), 'text/html');
        var english = !!doc.querySelector('a[href*="/language/english/"]');
        if (!english) throw new Error('nhentai title is not English');
        var imgs = [];
        Array.prototype.forEach.call(doc.querySelectorAll('#thumbnail-container img, .thumb-container img, .gallerythumb img, img'), function (im) {
          var s = absoluteUrl(lazyImg(im), item.url);
          if (!/^https:\/\/t\d?\.nhentai\.net\/galleries\//i.test(s)) return;
          var full = s.replace(/^https:\/\/t(\d?)\.nhentai\.net\//i, 'https://i$1.nhentai.net/');
          full = full.replace(/(\d+)t\.(webp|jpg|png)$/i, '$1.$2');
          if (imgs.indexOf(full) < 0) imgs.push(full);
        });
        var t2 = cleanTitle((doc.querySelector('h1, .title') || {}).textContent || '') || item.title;
        var og2 = doc.querySelector('meta[property="og:image"]');
        d = {
          g: null, pages: imgs, t: Date.now(), title: t2,
          cover: og2 ? absoluteUrl(og2.getAttribute('content'), item.url) : (item.cover || ''),
          tags: [], desc: ''
        };
        NH_CACHE[id] = d;
      }
    }
    return {
      source: 'nhentai', id: id, title: d.title || item.title,
      cover: d.cover || item.cover || '', desc: d.desc || '',
      author: 'nhentai', genre: '', tags: d.tags || [],
      url: item.url, ref: 'https://nhentai.net/',
      chapters: [{
        id: 'nh-' + id, url: 'nhentai://gallery/' + id,
        title: 'Full gallery' + (d.pages.length ? ' \u00b7 ' + d.pages.length + ' pages' : ''),
        no: 1, lang: 'en'
      }],
      more: false, chapterMode: 'native'
    };
  }
  async function nhentaiChapter(detail, _chapter) {
    var id = String(detail.id || '').replace(/\D+/g, '');
    var d = NH_CACHE[id];
    if (!d || !d.pages || !d.pages.length) {
      await nhentaiDetail({ id: id, url: detail.url, title: detail.title, cover: detail.cover });
      d = NH_CACHE[id];
    }
    if (!d || !d.pages || !d.pages.length) throw new Error('nhentai returned no pages');
    return d.pages.map(function (p) { return 'https://i.nhentai.net/' + p; });
  }

  var NATIVE_PROVIDERS = [
    {
      id: 'asura', name: 'Asura Scans', short: 'ASURA', ref: 'https://asurascans.com/',
      home: 'https://asurascans.com/browse',
      search: function (q) { return 'https://asurascans.com/browse?search=' + enc(q); },
      seriesRe: /\/comics\/[^/?#]+\/?$/i,
      chapterRe: /\/comics\/[^/?#]+\/chapter\/[^/?#]+/i,
      imgRe: /asura-images\/chapters\//i,
      render: true
    },
    {
      id: 'flame', name: 'Flame Comics', short: 'FLAME', ref: 'https://flamecomics.xyz/',
      home: 'https://flamecomics.xyz/browse',
      search: function (q) { return 'https://flamecomics.xyz/browse?search=' + enc(q); },
      seriesRe: /\/series\/\d+\/?$/i,
      chapterRe: /\/series\/\d+\/[a-f0-9]{6,}\/?$/i,
      imgRe: /cdn\.flamecomics\.xyz\/uploads\/images\/series\/\d+\/[a-f0-9]+\//i,
      exclude: /cover\.png|thumbnail|read_on_flame|og-default/i
    },
    {
      id: 'vortex', name: 'Vortex Scans', short: 'VORTEX', ref: 'https://vortexscans.org/',
      home: 'https://vortexscans.org/series/',
      search: function (q) { return 'https://vortexscans.org/series/?searchTerm=' + enc(q); },
      seriesRe: /\/series\/[^/?#]+\/?$/i,
      chapterRe: /\/series\/[^/?#]+\/chapter-[\d.]+/i,
      imgRe: /storage\.vortexscans\.org\/upload\/series\/.+\/page-/i
    },
    {
      id: 'hive', name: 'HiveToons', short: 'HIVE', ref: 'https://hivetoons.org/',
      home: 'https://hivetoons.org/series/',
      search: function (q) { return 'https://hivetoons.org/series/?searchTerm=' + enc(q); },
      seriesRe: /\/series\/[^/?#]+\/?$/i,
      chapterRe: /\/series\/[^/?#]+\/chapter-[\d.]+/i,
      imgRe: /storage\.hivetoon\.com\/public\/upload\/series\/.+\/page-/i,
      catalog: hiveCatalog
    },
    {
      id: 'comix', name: 'Comix', short: 'COMIX', ref: 'https://comix.to/',
      home: 'https://comix.to/',
      search: function (q) { return 'https://comix.to/search?q=' + enc(q); },
      seriesRe: /\/title\/[^/?#]+\/?$/i,
      chapterRe: /\/title\/[^/?#]+\/[^/?#]*(?:chapter|episode|[\d])[^/?#]*/i,
      render: true,
      catalog: comixCatalog
    },
    {
      id: 'manhuaus', name: 'ManhuaUS', short: 'MHUS', ref: 'https://manhuaus.club/',
      home: 'https://manhuaus.club/',
      search: function (q) { return 'https://manhuaus.club/?s=' + enc(q) + '&post_type=wp-manga'; },
      seriesRe: /\/manga\/[^/?#]+\/?$/i,
      chapterRe: /\/manga\/[^/?#]+\/chapter-[\d.]+\/?$/i,
      imgRe: /wp-content\/uploads\/WP-manga\/data\//i
    },
    {
      id: 'nelo', name: 'NeloManga', short: 'NELO', ref: 'https://www.nelomanga.net/',
      home: 'https://www.nelomanga.net/',
      search: function (q) { return 'https://www.nelomanga.net/?s=' + enc(q); },
      seriesRe: /\/manga\/[^/?#]+\/?$/i,
      chapterRe: /\/manga\/[^/?#]+\/chapter-[\d.]+/i,
      render: true
    },
    {
      id: 'tappytoon', name: 'Tappytoon', short: 'TAPPY', ref: 'https://www.tappytoon.com/',
      home: 'https://www.tappytoon.com/en/comics/discover',
      search: function (q) { return 'https://www.tappytoon.com/en/search?keyword=' + enc(q); },
      seriesRe: /\/en\/(?:book|comics)\/[^/?#]+\/?$/i,
      chapterRe: /\/en\/chapters?\/\d+/i,
      render: false,
      catalog: tappyCatalog, detail: tappyDetail, chapter: tappyChapter
    },
    {
      id: 'tapas', name: 'Tapas', short: 'TAPAS', ref: 'https://tapas.io/',
      home: 'https://tapas.io/',
      search: function (q) { return 'https://tapas.io/search?q=' + enc(q); },
      seriesRe: /\/series\/[^/?#]+\/?$/i,
      chapterRe: /\/episode\/\d+/i,
      imgRe: /us-a\.tapas\.io\/pc\//i,
      render: true,
      catalog: tapasCatalog, detail: tapasDetail, chapter: tapasChapter
    },
    {
      id: 'allmanga', name: 'AllManga', short: 'ALL', ref: 'https://allmanga.to/',
      home: 'https://allmanga.to/manga',
      search: function (q) { return 'https://allmanga.to/search?keyword=' + enc(q); },
      seriesRe: /\/manga\/[A-Za-z0-9]+$/,
      chapterRe: /(?:chapter|episode)/i,
      render: true,
      catalog: allmangaCatalog, detail: allmangaDetail, chapter: allmangaChapter
    },
    {
      id: 'mangafire', name: 'MangaFire', short: 'MFIRE', ref: 'https://mangafire.to/',
      home: 'https://mangafire.to/',
      search: function (q) { return 'https://mangafire.to/filter?keyword=' + enc(q); },
      seriesRe: /\/title\/[^/?#]+\/?$/i,
      chapterRe: /\/title\/[^/?#]+\/chapter\/\d+/i,
      render: true,
      detail: mangafireDetail, chapter: mangafireChapter
    },
    {
      id: 'toonsutra', name: 'ToonSutra', short: 'TOON', ref: 'https://www.toonsutra.com/',
      home: 'https://www.toonsutra.com/manhwa',
      search: function (q) { return 'https://www.toonsutra.com/search?q=' + enc(q); },
      seriesRe: /(?:comic|series|title|manga)\/[^/?#]+$/i,
      chapterRe: /(?:chapter|episode)/i,
      render: false,
      catalog: toonCatalog, detail: toonDetail, chapter: toonChapter
    }
  ];

  /* --------------------------------------------------------- 18+ reading
     Adult reading lives in its own registry and is reachable only when the
     caller mounts the reader with { adult: true } from the age-gated vault.
     General Reading never sees these providers, their titles or covers. */
  var ADULT_PROVIDERS = [
    {
      id: 'hentai20', name: 'Hentai20', short: 'H20', ref: 'https://hentai20.io/',
      home: 'https://hentai20.io/home1/',
      search: function (q) { return 'https://hentai20.io/?s=' + enc(q); },
      seriesRe: /\/manga\/[^/?#]+\/?$/i,
      chapterRe: /\/[^/?#]+-chapter-[\d.]+\/?$/i,
      imgRe: /img\.hentai1\.io\/.+\/chapter-/i,
      adult: true,
      tabs: [{ c: 'latest', n: 'Latest' }, { c: 'popular', n: 'Popular' }, { c: 'trending', n: 'Trending' }],
      genres: [
        { g: 'hentai', n: 'Hentai' }, { g: 'manhwa-hentai-26', n: 'Manhwa' },
        { g: 'manga-hentai-902', n: 'Manga' }, { g: 'doujinshi', n: 'Doujinshi' },
        { g: 'uncensored', n: 'Uncensored' }, { g: 'yuri', n: 'Yuri' },
        { g: 'gl', n: 'GL' }, { g: 'ecchi', n: 'Ecchi' },
        { g: 'adult', n: 'Adult' }, { g: 'supernatural', n: 'Supernatural' },
        { g: 'isekai', n: 'Isekai' }, { g: 'martial-arts', n: 'Martial Arts' }
      ],
      catalog: hentai20Catalog, detail: hentai20Detail, chapter: hentai20Chapter
    },
    {
      id: 'nhentai', name: 'nHentai', short: 'NH', ref: 'https://nhentai.net/',
      home: 'https://nhentai.net/',
      search: function (q) { return 'https://nhentai.net/search/?q=' + enc(q); },
      seriesRe: /\/g\/\d+\/?$/i,
      chapterRe: /\/g\/\d+\/\d+\/?$/i,
      adult: true,
      imgRe: /i\d*\.nhentai\.net\/galleries\//i,
      tabs: [{ c: 'popular', n: 'Popular' }, { c: 'recent', n: 'Recent' }],
      genres: [
        { g: 'big breasts', n: 'Big Breasts' }, { g: 'sole female', n: 'Sole Female' },
        { g: 'sole male', n: 'Sole Male' }, { g: 'nakadashi', n: 'Nakadashi' },
        { g: 'ahegao', n: 'Ahegao' }, { g: 'stockings', n: 'Stockings' },
        { g: 'paizuri', n: 'Paizuri' }, { g: 'glasses', n: 'Glasses' },
        { g: 'schoolgirl uniform', n: 'Schoolgirl' }, { g: 'femdom', n: 'Femdom' },
        { g: 'mosaic censorship', n: 'Censored' }, { g: 'full color', n: 'Full Color' }
      ],
      catalog: nhentaiCatalog, detail: nhentaiDetail, chapter: nhentaiChapter
    }
  ];
  function activeProviders() {
    return state.adultMode ? ADULT_PROVIDERS : NATIVE_PROVIDERS;
  }
  function safeProviders() {
    return NATIVE_PROVIDERS.filter(function (p) { return !p.adult; });
  }
  function adultProviders() {
    return ADULT_PROVIDERS;
  }
  function providerById(id) {
    var all = NATIVE_PROVIDERS.concat(ADULT_PROVIDERS);
    return all.filter(function (p) { return p.id === id; })[0] || null;
  }
  function nativeRef(source) {
    var p = providerById(source);
    return p ? p.ref : '';
  }
  function sourceName(source) {
    if (source === 'md') return 'MangaDex';
    if (source === 'wt') return 'WEBTOON';
    var p = providerById(source);
    return p ? p.name : 'Source';
  }
  function sourceShort(source) {
    if (source === 'md') return 'MD';
    if (source === 'wt') return 'WT';
    var p = providerById(source);
    return p ? p.short : 'SRC';
  }
  function isNativeSource(source) {
    return !!(source && source !== 'md' && source !== 'wt' && providerById(source));
  }
  function absolute(u, baseUrl) {
    try {
      var a = new URL(String(u || '').replace(/&amp;/g, '&'), baseUrl || location.href).toString();
      return /^https?:/i.test(a) ? a : '';
    } catch (e) { return ''; }
  }
  function firstSrc(im) {
    var attrs = ['data-src', 'data-lazy-src', 'data-original', 'data-url', 'data-image', 'src', 'data-cfsrc'];
    for (var i = 0; i < attrs.length; i++) {
      var v = im.getAttribute(attrs[i]);
      if (v && !/^data:image\/(?:gif|svg)/i.test(v) && !/blank|placeholder|spacer|transparent/i.test(v)) return v;
    }
    var ss = im.getAttribute('srcset') || im.getAttribute('data-srcset') || '';
    if (ss) { var p = ss.split(',').pop().trim().split(/\s+/)[0]; if (p) return p; }
    return '';
  }
  function snapHtml(html, url) {
    var doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    var out = {
      url: url, html: String(html || ''), title: text(doc.querySelector('title')),
      h1: text(doc.querySelector('h1')),
      og: absolute((doc.querySelector('meta[property="og:image"]') || {}).content, url),
      desc: (doc.querySelector('meta[name="description"]') || {}).content || '',
      anchors: [], images: [], readers: [],
      text: text(doc.body).slice(0, 4000)
    };
    var seenA = {};
    $$('a[href]', doc).forEach(function (a) {
      var h = absolute(a.getAttribute('href'), url);
      if (!h || seenA[h]) return;
      seenA[h] = 1;
      var im = a.querySelector('img');
      out.anchors.push({
        h: h, t: text(a).slice(0, 180),
        a: im ? String(im.getAttribute('alt') || '').replace(/\s+/g, ' ').trim().slice(0, 180) : '',
        i: im ? absolute(firstSrc(im), url) : ''
      });
    });
    var seenI = {};
    $$('img', doc).forEach(function (im) {
      var s = absolute(firstSrc(im), url);
      if (!s || seenI[s]) return;
      seenI[s] = 1;
      out.images.push({
        s: s, a: String(im.getAttribute('alt') || '').slice(0, 160),
        w: parseInt(im.getAttribute('width') || '0', 10) || 0,
        h: parseInt(im.getAttribute('height') || '0', 10) || 0
      });
    });
    var readerSel = '#images img, .reading-content img, .chapter-content img, .entry-content img, ' +
      '.page-break img, .view-chapter img, [class*="reader"] img, [class*="chapter"] img, ' +
      '[class*="page"] img, [class*="comic"] img, [class*="manga"] img';
    var seenR = {};
    $$(readerSel, doc).forEach(function (im) {
      var s = absolute(firstSrc(im), url);
      if (!s || seenR[s]) return;
      seenR[s] = 1;
      out.readers.push({ s: s, w: parseInt(im.getAttribute('width') || '0', 10) || 0, h: parseInt(im.getAttribute('height') || '0', 10) || 0 });
    });
    return out;
  }
  async function renderSnap(url, kind) {
    var B = await base();
    var r = await withTimeout(fetch(withToken(B + '/render?url=' + enc(url) + '&kind=' + enc(kind || 'other')), { cache: 'no-store' }), 70000);
    var raw = await withTimeout(r.text(), 70000);
    var j;
    try { j = JSON.parse(raw); } catch (e) { throw new Error('render bridge returned no data'); }
    if (!j || !j.ok) throw new Error((j && j.error) || 'render failed');
    return j;
  }
  async function nativeSnapshot(p, url, kind) {
    if (p.render) {
      try { return await renderSnap(url, kind); }
      catch (e) {
        try { return snapHtml(await page(url, 32000), url); } catch (e2) { throw e; }
      }
    }
    try {
      var html = await page(url, 32000);
      if (!html || html.length < 1200 ||
          (/Just a moment|challenge-platform|cf-mitigated/i.test(html) && !/<a\s[^>]*href=/i.test(html))) {
        throw new Error('source returned a client shell');
      }
      return snapHtml(html, url);
    } catch (e) {
      return await renderSnap(url, kind);
    }
  }
  function cleanTitle(v) {
    return String(v || '').replace(/\s+/g, ' ')
      .replace(/^\d{1,3}[.)]\s+/, '')
      .replace(/\s+(?:Hot|New|Top|Trending|Completed|Ongoing|UP)\b.*$/i, '')
      .replace(/\s+\d+(?:\.\d+)?\s+\d+[dhm]\s+ago.*$/i, '')
      .trim();
  }
  function slugOf(url) {
    try {
      var u = new URL(url);
      var parts = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
      return parts[parts.length - 1] || u.hostname;
    } catch (e) { return String(url || '').slice(-40); }
  }
  function badImage(u) {
    return /logo|favicon|avatar|icon|banner|thumbnail|thumb|cover|profile|emoji|placeholder|spacer|loading|transparent|read_on_|featured|discord|patreon|ko-fi|kofi|twitter|facebook|reddit|ads?\.|doubleclick|analytics|pixel|1x1|blank\./i.test(String(u || ''));
  }
  function nonEnglishLabel(v) {
    return /(?:^|\s|\()(?:raw|raws)(?:$|\s|\))|\[(?:ES|PT|FR|DE|ID|IT|RU|TH|VI|JA|KO|ZH|AR|TR)\]/i.test(String(v || ''));
  }
  function chapterLabelOf(t, fallback) {
    var s = String(t || '').replace(/\s+/g, ' ').trim();
    var m = /(?:chapter|episode|ch\.?|ep\.?)\s*([\d.]+)/i.exec(s);
    if (m) return 'Chapter ' + m[1];
    if (s) return s.slice(0, 90);
    return fallback || 'Chapter';
  }
  function chapterNoOf(t, u) {
    var m = /(?:chapter|episode|ch\.?|ep\.?)\s*([\d.]+)/i.exec(String(t || ''));
    if (m) return parseFloat(m[1]);
    m = /(?:chapter|episode|ch|ep)[-_/]?([\d.]+)/i.exec(String(u || ''));
    if (m) return parseFloat(m[1]);
    m = /[-_/]([\d.]+)(?:[./?#]|$)/.exec(String(u || ''));
    return m ? parseFloat(m[1]) : 1e9;
  }
  function parseNativeCatalog(snap, p) {
    var out = [], seen = {};
    (snap.anchors || []).forEach(function (a) {
      var u = String(a.h || '').replace(/[?#].*$/, '');
      if (!p.seriesRe.test(u)) return;
      if (p.chapterRe && p.chapterRe.test(u)) return;
      if (u === p.home || /\/search|\/browse\/?$|\/filter\?/i.test(u)) return;
      if (seen[u]) return;
      var title = cleanTitle(a.a || a.t || '');
      if (!title || /^(home|browse|search|login|sign in|sign up|register|discord|random|series|manga|comics?|all)$/i.test(title)) return;
      seen[u] = 1;
      out.push({
        source: p.id, id: slugOf(u), title: title,
        cover: a.i || '', url: u, ref: p.ref, adult: false
      });
    });
    return out.slice(0, 48);
  }
  function parseNativeDetail(snap, item, p) {
    var d = {
      source: p.id, id: item.id || slugOf(item.url), title: cleanTitle(snap.h1) || cleanTitle(snap.title) || item.title,
      cover: snap.og || item.cover || '', desc: String(snap.desc || '').trim(),
      author: p.name, genre: '', tags: [], url: item.url, ref: p.ref,
      chapters: [], more: false, chapterMode: 'native'
    };
    if (!d.cover) {
      var im = (snap.images || []).filter(function (x) {
        return x.w >= 200 && x.h >= 200 && !/logo|avatar|icon|banner|emoji/i.test(x.s);
      })[0];
      if (im) d.cover = im.s;
    }
    var seen = {};
    var seenNo = {};
    (snap.anchors || []).forEach(function (a) {
      var u = String(a.h || '').replace(/#.*$/, '');
      if (!p.chapterRe.test(u)) return;
      if (u.replace(/\/+$/, '') === String(item.url).replace(/\/+$/, '')) return;
      if (seen[u]) return;
      var label = a.t || a.a || '';
      if (nonEnglishLabel(label)) return;
      /* "Latest Chapter" duplicates the newest real row; skip it so the
         numbered label wins. "First Chapter" is the only row for chapter 1. */
      if (/^latest chapter$/i.test(label.trim())) return;
      var no = /^first chapter$/i.test(label.trim()) ? 1 : chapterNoOf(label, u);
      var keyNo = (no < 1e9 ? String(no) : u) + '|' + label.replace(/\s+\d+\s+(?:hour|day|week|month|year)s?\s+ago.*$/i, '').trim();
      if (seenNo[keyNo]) return;
      seenNo[keyNo] = 1;
      seen[u] = 1;
      d.chapters.push({
        id: u, url: u, title: chapterLabelOf(label, 'Chapter'),
        no: no, lang: 'en'
      });
    });
    /* Madara-based sites embed the complete chapter list as JSON; the visible
       anchors only carry "Read now"/"Latest", so prefer the JSON when present. */
    try {
      var jdoc = new DOMParser().parseFromString(String(snap.html || ''), 'text/html');
      var jel = jdoc.getElementById('mk-chapters-data');
      var jdata = jel ? JSON.parse(jel.textContent || '{}') : null;
      if (jdata && jdata.items && jdata.items.length) {
        var jseen = {};
        d.chapters = [];
        jdata.items.forEach(function (x) {
          var ju = String(x.url || '').replace(/\\\//g, '/');
          if (!ju || jseen[ju]) return;
          jseen[ju] = 1;
          var jno = parseFloat(x.num);
          if (!isFinite(jno)) jno = chapterNoOf(x.name || '', ju);
          d.chapters.push({
            id: ju, url: ju, title: String(x.name || ('Chapter ' + jno)).trim(),
            no: jno, lang: 'en'
          });
        });
      }
    } catch (e) {}
    d.chapters.sort(function (x, y) { return (x.no - y.no) || String(x.url).localeCompare(String(y.url)); });
    if (!d.desc) d.desc = '';
    return d;
  }
  function parseNativeChapter(snap, p, chapterUrl) {
    var urls = [], seen = {};
    function push(raw, relaxed) {
      var u = absolute(raw, chapterUrl);
      if (!u || seen[u]) return;
      if (/^data:/i.test(u)) return;
      if (p.exclude && p.exclude.test(u)) return;
      if (badImage(u)) return;
      if (p.imgRe && !p.imgRe.test(u) && !relaxed) return;
      seen[u] = 1;
      urls.push(u);
    }
    var readers = (snap.readers || []).map(function (r) { return r.s || r; }).filter(Boolean);
    readers.forEach(function (u) { push(u, false); });
    if (!urls.length) readers.forEach(function (u) { push(u, true); });
    if (!urls.length) {
      (snap.images || []).forEach(function (im) {
        if (im.w >= 280 && im.h >= 220) push(im.s, true);
      });
    }
    if (!urls.length) (snap.images || []).forEach(function (im) { push(im.s, true); });
    function order(u) {
      var m = /(?:page|p|ch|chapter|ep|episode)[-_]?0*(\d{1,4})/i.exec(u) || /\/0*(\d{1,4})\.(?:jpe?g|png|webp)/i.exec(u);
      return m ? parseInt(m[1], 10) : 0;
    }
    var nums = urls.map(order);
    if (nums.some(function (n) { return n > 0; }) && new Set(nums).size > 1) {
      urls = urls.map(function (u, i) { return { u: u, n: nums[i] || (i + 1) }; })
        .sort(function (x, y) { return x.n - y.n; }).map(function (x) { return x.u; });
    }
    return urls;
  }
  /* ------------------------------------------------------- provider adapters
     Each provider keeps one native path. Sites with a public JSON surface
     (ToonSutra, AllManga, Tappytoon metadata) use it directly through the
     reading bridge. Sites that sign requests in page JavaScript (MangaFire,
     Tappytoon viewer) are read from the XHR bodies their own page fetched by
     the app's hidden window. Everything is in-app; no external browser. */
  var TS_AUTH_KEY = 'sb.read.toonsutra.auth';
  function tsAuth() {
    var a = lsGet(TS_AUTH_KEY, null);
    return a && a.access ? a : null;
  }
  function tsSaveAuth(a) { lsSet(TS_AUTH_KEY, a || null); }
  async function tsSignup() {
    var dev = lsGet('sb.read.toonsutra.device', '');
    if (!dev) {
      try { dev = window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2); } catch (e) { dev = String(Date.now()); }
      lsSet('sb.read.toonsutra.device', dev);
    }
    var j = await readNetJSON('https://api.toonsutra.com/api/v4.0/user/sign-up-guest-user', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_id: dev })
    });
    var t = (j && j.data && j.data.tokens) || {};
    if (!t.accessToken || !t.oldApiAccessToken) throw new Error('ToonSutra guest sign-in failed');
    var a = { access: t.accessToken, old: t.oldApiAccessToken, at: Date.now() };
    tsSaveAuth(a);
    return a;
  }
  async function tsApi(path) {
    var a = tsAuth() || await tsSignup();
    for (var attempt = 0; attempt < 2; attempt++) {
      var j = await readNetJSON('https://api.toonsutra.com/api/' + path, {
        headers: { authorization: a.access, auth: a.old, os: 'web' }
      });
      if (j && j.statusCode !== 400 && j.statusCode !== 401 && j.statusCode !== 403) return j;
      if (attempt === 0) { tsSaveAuth(null); a = await tsSignup(); }
    }
    throw new Error('ToonSutra refused the request');
  }
  function toonTitle(c) {
    var t = c && (c.comic_english_alias || c.english_alias || c.comic_name_with_language || c.english_name || c.name || '');
    return cleanTitle(String(t || '').replace(/\s*\((?:English|Hindi|Indonesian)\)\s*$/i, '')) || 'Untitled';
  }
  function toonCard(c) {
    var id = String(c.comic_id || c.id || '');
    return {
      source: 'toonsutra', id: id, title: toonTitle(c),
      cover: String(c.comic_thumbnail || c.thumbnailUrl || c.cover || ''),
      desc: stripTags(c.comic_discription || c.description || c.synopsis || ''),
      author: String(c.author_name || c.publisher_name || ''),
      tags: (c.comic_genre_list || c.genre_list || []).map(function (g) { return g.genre_name || g.name || ''; }).filter(Boolean),
      url: 'https://www.toonsutra.com/comic/' + enc(id), ref: 'https://www.toonsutra.com/',
      adult: false
    };
  }
  async function toonCatalog(q) {
    var j = await tsApi('v3.0/mobile-app/comic?filter[language_id]=1&page=1&limit=24&sort=popular');
    var list = ((j.result && j.result.list) || []).map(toonCard);
    if (q) {
      var needle = q.toLowerCase();
      var hit = list.filter(function (it) { return it.title.toLowerCase().indexOf(needle) >= 0; });
      if (!hit.length) {
        var j2 = await tsApi('v3.0/mobile-app/comic?filter[language_id]=1&page=2&limit=60&sort=popular');
        hit = ((j2.result && j2.result.list) || []).map(toonCard).filter(function (it) { return it.title.toLowerCase().indexOf(needle) >= 0; });
      }
      list = hit;
    }
    return list;
  }
  async function toonDetail(item) {
    var id = enc(String(item.id));
    var pair = await Promise.all([
      tsApi('v3.0/mobile-app/comic?filter[comic_id]=' + id),
      tsApi('v3.0/mobile-app/chapter?filter[comic_id]=' + id)
    ]);
    var c = ((pair[0].result && pair[0].result.list) || [])[0] || {};
    var chapters = ((pair[1].result && pair[1].result.list) || []).map(function (ch) {
      var images = (ch.comic_episode_urls || []).map(function (x) { return x.chapter_image || x.chapter_image_url || ''; }).filter(Boolean);
      if (!images.length && ch.comic_chapter_url) images = [ch.comic_chapter_url];
      var no = Number(ch.chapter_num);
      return {
        id: String(ch.chapter_id || no), url: 'https://www.toonsutra.com/comic/' + id + '/chapter/' + enc(String(ch.chapter_id || no)),
        title: 'Chapter ' + (isFinite(no) ? no : (ch.sequence_number || ch.name || '')),
        no: isFinite(no) ? no : 1e9, lang: 'en', images: images
      };
    }).filter(function (ch) { return ch.images && ch.images.length; });
    chapters.sort(function (a, b) { return a.no - b.no; });
    return {
      source: 'toonsutra', id: String(c.comic_id || item.id), title: toonTitle(c) || item.title,
      cover: String(c.comic_thumbnail || item.cover || ''),
      desc: stripTags(c.description || c.comic_discription || item.desc || ''),
      author: String(c.author_name || c.publisher_name || ''), genre: '',
      tags: (c.comic_genre_list || []).map(function (g) { return g.genre_name || ''; }).filter(Boolean),
      url: item.url, ref: 'https://www.toonsutra.com/', chapters: chapters,
      more: false, chapterMode: 'native'
    };
  }
  function toonChapter(_detail, chapter) {
    if (chapter.images && chapter.images.length) return Promise.resolve(chapter.images);
    throw new Error('No chapter pages');
  }

  var AM_API = 'https://api.allanime.day/api';
  async function amGql(query, variables) {
    var j = await readNetJSON(AM_API, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query, variables: variables || {} })
    });
    if (j.errors && j.errors.length) throw new Error(j.errors[0].message || 'AllManga API error');
    return j.data || {};
  }
  function amCover(u) {
    var v = String(u || '');
    if (/^https?:/i.test(v)) return v;
    return v ? 'https://wp.allmanga.to/' + v.replace(/^\/+/, '') : '';
  }
  function amCard(x) {
    return {
      source: 'allmanga', id: String(x._id || ''), title: cleanTitle(x.englishName || x.name) || 'Untitled',
      cover: amCover(x.thumbnail), desc: stripTags(x.description || ''),
      author: 'AllManga', tags: (x.genres || []).slice(0, 8), genre: '',
      url: 'https://allmanga.to/manga/' + enc(String(x._id || '')),
      ref: 'https://allmanga.to/', adult: false
    };
  }
  async function allmangaCatalog(q) {
    var g = await amGql('query($search:SearchInput,$limit:Int,$page:Int){mangas(search:$search,limit:$limit,page:$page){edges{_id name englishName thumbnail description status genres availableChapters availableChaptersDetail}}}',
      { search: { query: String(q || ''), allowAdult: false }, limit: 30, page: 1 });
    return (((g.mangas || {}).edges) || []).map(amCard).filter(function (x) { return x.id; });
  }
  async function allmangaDetail(item) {
    var g = await amGql('query($id:String!){manga(_id:$id){_id name englishName thumbnail description status genres availableChaptersDetail}}', { id: item.id });
    var m = g.manga || {};
    var subs = ((m.availableChaptersDetail || {}).sub) || [];
    var chapters = subs.map(function (n) {
      return {
        id: String(n), no: parseFloat(n),
        title: 'Chapter ' + n,
        url: 'https://allmanga.to/manga/' + enc(item.id) + '/chapter-' + enc(String(n)) + '-sub',
        lang: 'en'
      };
    }).sort(function (a, b) { return (a.no || 0) - (b.no || 0); });
    return {
      source: 'allmanga', id: item.id, title: cleanTitle(m.englishName || m.name || item.title),
      cover: amCover(m.thumbnail) || item.cover, desc: stripTags(m.description || item.desc || ''),
      author: 'AllManga', genre: '', tags: (m.genres || []).slice(0, 8),
      url: item.url, ref: 'https://allmanga.to/', chapters: chapters, more: false, chapterMode: 'native'
    };
  }
  function collectPageUrls(value, out, depth) {
    out = out || [];
    depth = depth || 0;
    if (!value || depth > 8 || out.length > 400) return out;
    if (typeof value === 'string') {
      if (/^https?:\/\/[^"'\s]+\.(?:jpe?g|png|webp|avif)(?:\?[^"'\s]*)?$/i.test(value)) out.push(value);
      return out;
    }
    if (Array.isArray(value)) { value.forEach(function (x) { collectPageUrls(x, out, depth + 1); }); return out; }
    if (typeof value === 'object') {
      Object.keys(value).forEach(function (k) {
        if (/^(thumbnail|cover|poster|image|avatar|logo|icon|banner)$/i.test(k) && typeof value[k] === 'string') return;
        collectPageUrls(value[k], out, depth + 1);
      });
    }
    return out;
  }
  async function allmangaChapter(detail, chapter) {
    /* Best effort: the GraphQL endpoint accepts pictureUrls when it is not
       gating the request with a Turnstile challenge. queryAt is required or
       the API answers AA_CRYPTO_MISSING. */
    try {
      var g = await amGql('query($mangaId:String!,$translationType:VaildTranslationTypeMangaEnumType!,$chapterString:String!,$page:Int,$limit:Int,$offset:Int,$queryAt:String){chapterPages(mangaId:$mangaId,translationType:$translationType,chapterString:$chapterString,page:$page,limit:$limit,offset:$offset,queryAt:$queryAt){edges{pictureUrls pictureUrlsProcessed pictureUrlHead}pageInfo{total}}}',
        {
          mangaId: detail.id, translationType: 'sub', chapterString: String(chapter.id),
          limit: 100, offset: 0, queryAt: new Date().toISOString()
        });
      var edges = (((g.chapterPages || {}).edges) || []);
      var urls = [];
      edges.forEach(function (e) {
        var head = String(e.pictureUrlHead || '');
        var list = e.pictureUrls;
        if (typeof list === 'string') {
          try { list = JSON.parse(list); } catch (x) { list = [list]; }
        }
        (Array.isArray(list) ? list : []).forEach(function (u) {
          var v = String(u || '');
          if (!v) return;
          if (!/^https?:/i.test(v)) v = head ? head.replace(/\/+$/, '') + '/' + v.replace(/^\/+/, '') : v;
          if (/^https?:/i.test(v)) urls.push(v);
        });
      });
      urls = urls.filter(function (u, i, a) { return a.indexOf(u) === i; });
      if (urls.length) return urls;
    } catch (e) {}
    try {
      var bodies = await readCapture(chapter.url, '/api|graphql|chapter', 3, 30000);
      var found = [];
      bodies.forEach(function (b) {
        if (b.body) collectPageUrls(b.body, found);
      });
      found = found.filter(function (u, i, a) { return a.indexOf(u) === i && !/thumbnail|cover|avatar|logo/i.test(u); });
      if (found.length) return found;
    } catch (e2) {}
    throw new Error('AllManga gates this chapter behind a challenge (Turnstile). No external browser is opened; try another source.');
  }

  function mangafireHid(url) {
    try {
      var p = new URL(url).pathname.split('/').filter(Boolean);
      var slug = p[1] || '';
      return slug.split('-')[0];
    } catch (e) { return ''; }
  }
  async function mangafireDetail(item) {
    var bodies = await readCapture(item.url, '/api/titles/[^/]+/chapters', 1, 26000);
    var payload = bodies[0] && bodies[0].body;
    var rows = (payload && payload.items) || [];
    var seen = {}, chapters = [];
    rows.forEach(function (ch) {
      var id = String(ch.id || '');
      if (!id || seen[id] || String(ch.language || 'en').toLowerCase() !== 'en') return;
      seen[id] = 1;
      var no = Number(ch.number);
      chapters.push({
        id: id, no: isFinite(no) ? no : 1e9,
        title: 'Chapter ' + (ch.number != null ? ch.number : id),
        url: String(item.url).replace(/\/+$/, '') + '/chapter/' + enc(id), lang: 'en'
      });
    });
    chapters.sort(function (a, b) { return a.no - b.no; });
    return {
      source: 'mangafire', id: mangafireHid(item.url) || item.id,
      title: item.title || cleanTitle(item.url.split('/').pop()), cover: item.cover || '',
      desc: item.desc || '', author: 'MangaFire', genre: '', tags: [],
      url: item.url, ref: 'https://mangafire.to/', chapters: chapters,
      more: false, chapterMode: 'native'
    };
  }
  async function mangafireChapter(_detail, chapter) {
    var bodies = await readCapture(chapter.url, '/api/chapters/\\d+', 1, 28000);
    var payload = bodies[0] && bodies[0].body;
    var pages = (payload && payload.data && payload.data.pages) || [];
    var urls = pages.sort(function (a, b) { return (a.sort || 0) - (b.sort || 0); })
      .map(function (p) { return p.url || ''; }).filter(Boolean);
    if (!urls.length) throw new Error('MangaFire returned no pages');
    return urls;
  }

  function tapasSeriesUrl(u) {
    var m = /\/series\/([^/?#]+)/i.exec(String(u || ''));
    return m ? 'https://tapas.io/series/' + m[1] : String(u || '');
  }
  /* Tapas catalogue cards show read counts ("3hr53.7M") instead of titles; the
     lazy-load image file name carries the real series name. */
  function tapasImageTitle(u) {
    var m = /\/(?:c2_)?([^/?#]+?)\.(?:png|jpe?g|webp)(?:[?#]|$)/i.exec(String(u || ''));
    if (!m) return '';
    var s = decodeURIComponent(m[1]).replace(/_s\d+$/i, '');
    s = s.replace(/_s_/g, "'s ").replace(/__+/g, ' - ').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
    return s ? cleanTitle(s) : '';
  }
  /* Tapas stores cover paths without an extension; the CDN serves the real
     file at the same path with `.webp` appended. */
  function tapasCover(u) {
    u = String(u || '');
    if (!u) return '';
    return /\.(?:jpe?g|png|webp|gif)$/i.test(u) ? u : u + '.webp';
  }
  function tapasCardTitle(a) {
    var line = cleanTitle(a.a || a.t || '');
    if (line && /[a-z]{3,}/i.test(line) && !/^(read|tapas|series|comics?|home|search|login|sign up)$/i.test(line)) return line;
    return tapasImageTitle(a.i) || line;
  }
  async function tapasCatalog(q) {
    /* Tapas' server shell paints skeleton cards and hydrates its menu from a
       JSON API; a hidden render never sees the finished grid. Read the same
       public catalogue endpoint directly so browsing and search stay native. */
    var out = [], seen = {}, pages = q ? 3 : 1;
    for (var pg = 0; pg < pages; pg++) {
      var j = await readNetJSON('https://story-api.tapas.io/cosmos/api/v1/landing/free?category_type=COMIC&subtab_id=7&sort_option=POPULAR&page=' + pg + '&size=50', {
        headers: { 'Accept': 'application/json', origin: 'https://tapas.io' }
      });
      var items = (j && j.data && j.data.items) || [];
      items.forEach(function (it) {
        var id = String(it.seriesId || '');
        if (!id || seen[id]) return;
        var title = cleanTitle(it.title);
        if (!title) return;
        if (q && title.toLowerCase().indexOf(String(q).toLowerCase()) < 0) return;
        var ap = it.assetProperty || {};
        var cover = tapasCover((ap.bookCoverImage && ap.bookCoverImage.path) ||
          (ap.thumbnailImage && ap.thumbnailImage.path) || '');
        seen[id] = 1;
        out.push({
          source: 'tapas', id: id, title: title, cover: cover,
          url: 'https://tapas.io/series/' + id, ref: 'https://tapas.io/',
          adult: !!it.mature, desc: String(it.description || '').slice(0, 600)
        });
      });
    }
    return out.slice(0, 48);
  }
  async function tapasDetail(item) {
    var url = tapasSeriesUrl(item.url).replace(/\/+$/, '') + '/info';
    var snap = await renderSnap(url, 'detail');
    var doc = new DOMParser().parseFromString(String(snap.html || ''), 'text/html');
    var og = doc.querySelector('meta[property="og:image"]');
    var fromPage = String(snap.title || '').replace(/^Read\s+/i, '').replace(/\s*\|\s*Tapas.*$/i, '');
    var title = cleanTitle(snap.h1) || cleanTitle(fromPage) || cleanTitle(item.title);
    var chapters = [], seen = {};
    (snap.anchors || []).forEach(function (a) {
      var m = /\/episode\/(\d+)/.exec(a.h || '');
      if (!m || seen[m[1]]) return;
      seen[m[1]] = 1;
      /* Episode rows carry an image whose alt text is the same on every row,
         so trust the anchor text first and fall back to list order. */
      var label = String(a.t || a.a || '');
      var no = null;
      var em = /(?:episode|ep)\s*\.?\s*(\d+(?:\.\d+)?)/i.exec(label);
      if (em) no = parseFloat(em[1]);
      if (no == null || !isFinite(no)) no = chapters.length + 1;
      chapters.push({
        id: m[1], no: no, title: 'Episode ' + no,
        url: 'https://tapas.io/episode/' + m[1], lang: 'en'
      });
    });
    var uniq = {};
    chapters.forEach(function (c) { uniq[c.no] = 1; });
    if (chapters.length > 1 && Object.keys(uniq).length === 1) {
      chapters.forEach(function (c, i) { c.no = i + 1; c.title = 'Episode ' + c.no; });
    }
    chapters.sort(function (a, b) { return a.no - b.no; });
    return {
      source: 'tapas', id: item.id, title: title,
      cover: (og && og.getAttribute('content')) || snap.og || item.cover || '',
      desc: String(snap.desc || '').slice(0, 1200),
      author: 'Tapas', genre: '', tags: [], url: item.url,
      ref: 'https://tapas.io/', chapters: chapters, more: false, chapterMode: 'native'
    };
  }
  async function tapasChapter(_detail, chapter) {
    var snap = await renderSnap(chapter.url, 'chapter');
    var urls = [], seen = {};
    /* Tapas keeps the previous episode mounted after its auto-advance, and
       the page also carries avatars and related-series art. Scope to the
       requested episode's own .episode-unit and keep only /pc/ pages. */
    function add(u) {
      u = String(u || '').replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/&amp;/g, '&');
      /* Raw Tapas HTML stores lazy image URLs as \"https://us-a.tapas.io/pc/...\",
         so pull the real URL out before validating it. */
      var m = /https?:\/\/(?:us-a\.)?tapas\.io\/pc\/[^\s"'\\]+/i.exec(u);
      if (m) u = m[0];
      if (!/^https?:\/\/[^"'\s]+$/i.test(u)) return;
      if (!/tapas\.io\/pc\//i.test(u)) return;
      if (seen[u]) return;
      seen[u] = 1; urls.push(u);
    }
    var s = String(snap.html || '').replace(/\\\//g, '/').replace(/\\u0026/gi, '&');
    var epId = String(chapter.id || '').replace(/\D/g, '') ||
      ((/\/episode\/(\d+)/.exec(chapter.url || '') || [])[1] || '');
    var scope = null;
    try {
      var doc = new DOMParser().parseFromString(s, 'text/html');
      scope = epId ? doc.querySelector('[data-ep-id="' + epId + '"]') : null;
      if (!scope && epId) scope = doc.getElementById('episode-' + epId);
      if (!scope) scope = doc;
      Array.prototype.forEach.call(scope.querySelectorAll('img'), function (im) {
        add(im.getAttribute('data-src') || im.getAttribute('src') || '');
      });
    } catch (e) {}
    if (!urls.length) {
      (snap.readers || []).forEach(function (r) { add(r.s || r); });
      (snap.images || []).forEach(function (im) { add(im.s); });
    }
    if (!urls.length) throw new Error('Tapas returned no pages');
    return urls;
  }

  function tappyState(html) {
    var j = jsonAttr(html, '__NEXT_DATA__');
    return (j && j.props && j.props.initialState) || null;
  }
  function tappyCard(c) {
    return {
      source: 'tappytoon', id: String(c.slug || c.id || ''), title: cleanTitle(c.title) || 'Untitled',
      cover: String(c.coverImageUrl || c.thumbnailUrl || ''), desc: stripTags(c.longDescription || c.synopsis || ''),
      author: (c.authors || []).map(function (a) { return a.name || a; }).filter(Boolean).join(', '),
      tags: (c.genres || []).map(function (g) { return g.name || g; }).filter(Boolean),
      url: 'https://www.tappytoon.com/en/book/' + enc(String(c.slug || c.id || '')),
      ref: 'https://www.tappytoon.com/', adult: !!c.isMature
    };
  }
  async function tappyCatalog(q) {
    /* Tappytoon search is client-side only; the initialState of the discover
       page carries the catalogue. Filter locally instead of trusting the
       ?keyword= route, which renders an empty shell. */
    var snap = await renderSnap('https://www.tappytoon.com/en/comics/discover', 'catalog');
    var st = tappyState(snap.html || '');
    var comics = (st && st.entities && st.entities.comics) || {};
    var list = Object.keys(comics).map(function (k) { return tappyCard(comics[k]); });
    if (q) {
      var needle = q.toLowerCase();
      list = list.filter(function (it) { return it.title.toLowerCase().indexOf(needle) >= 0; });
    }
    return list.filter(function (x) { return x.id; }).slice(0, 48);
  }
  async function tappyDetail(item) {
    var snap = await renderSnap(item.url, 'detail');
    var st = tappyState(snap.html || '');
    if (!st) throw new Error('Tappytoon returned no metadata');
    var comics = st.entities.comics || {};
    var cid = String(item.id);
    var c = Object.keys(comics).map(function (k) { return comics[k]; }).filter(function (x) {
      return String(x.slug || '') === cid || String(x.id || '') === cid;
    })[0] || Object.keys(comics).map(function (k) { return comics[k]; })[0];
    if (!c) throw new Error('Tappytoon title missing');
    var chapters = Object.keys(st.entities.chapters || {}).map(function (k) { return st.entities.chapters[k]; }).filter(function (ch) {
      return !ch.comicId || String(ch.comicId) === String(c.id);
    }).map(function (ch) {
      var no = Number(ch.order);
      return {
        id: String(ch.id), no: isFinite(no) ? no : 1e9,
        title: ch.title || ('Episode ' + (isFinite(no) ? no + 1 : ch.id)),
        url: 'https://www.tappytoon.com/en/chapters/' + enc(String(ch.id)),
        lang: 'en', free: !!ch.isFree
      };
    });
    chapters.sort(function (a, b) { return a.no - b.no; });
    return {
      source: 'tappytoon', id: String(c.slug || item.id), title: cleanTitle(c.title) || item.title,
      cover: String(c.coverImageUrl || item.cover || ''), desc: stripTags(c.longDescription || c.synopsis || item.desc || ''),
      author: (c.authors || []).map(function (a) { return a.name || a; }).filter(Boolean).join(', '),
      genre: '', tags: (c.genres || []).map(function (g) { return g.name || g; }).filter(Boolean),
      url: item.url, ref: 'https://www.tappytoon.com/', chapters: chapters,
      more: false, chapterMode: 'native'
    };
  }
  async function tappyChapter(_detail, chapter) {
    var bodies = await readCapture(chapter.url, '/content-delivery/contents/manifest', 1, 32000);
    var manifest = bodies[0] && bodies[0].body;
    var files = (manifest && manifest.files) || [];
    var urls = files.sort(function (a, b) { return (a.sortKey || 0) - (b.sortKey || 0); })
      .map(function (f) { return f.url || ''; }).filter(Boolean);
    if (!urls.length) throw new Error('Tappytoon returned no pages');
    return urls;
  }

  async function nativeLoad(append) {
    var req = ++state.req;
    var p = providerById(state.source);
    if (!p) return;
    if (state.ctl) { try { state.ctl.abort(); } catch (e) {} }
    var ctl = new AbortController();
    state.ctl = ctl;
    state.loading = true;
    state.more = false;
    var page = append ? (state.page || 1) + 1 : 1;
    if (!append) { state.items = []; state.offset = 0; }
    paintBody();
    try {
      var list = null, more = false;
      if (p.catalog) {
        try {
          if (state.adultMode) {
            var got = await p.catalog({ q: state.q, genre: state.genre, tab: state.tab, page: page });
            list = (got && got.items) || got || [];
            more = !!(got && got.more);
          } else {
            list = await p.catalog(state.q);
          }
        } catch (e) { list = null; }
      }
      if (!list) {
        var url = state.q && p.search ? p.search(state.q) : p.home;
        var snap = await nativeSnapshot(p, url, 'catalog');
        list = parseNativeCatalog(snap, p);
      }
      if (req !== state.req) return;
      list = list.filter(ratingAllowed);
      if (state.q && !p.catalog) {
        var q = state.q.toLowerCase();
        var hit = list.filter(function (it) { return it.title.toLowerCase().indexOf(q) >= 0; });
        if (hit.length) list = hit;
      }
      state.items = append ? state.items.concat(list) : list;
      state.total = state.items.length;
      state.more = state.adultMode ? more : false;
      state.page = page;
    } catch (e) {
      if (req !== state.req) return;
      if (!append) { state.items = []; state.total = 0; }
      if (e && e.name === 'AbortError') return;
      toast(p.name + ' is unavailable');
    }
    state.loading = false;
    paintBody();
  }
  async function nativeDetail(item) {
    var p = providerById(item.source);
    if (!p) throw new Error('Unknown provider');
    if (p.detail) {
      try {
        var d0 = await p.detail(item);
        if (d0 && d0.chapters && d0.chapters.length) return d0;
      } catch (e) {}
    }
    var snap = await nativeSnapshot(p, item.url, 'detail');
    var d = parseNativeDetail(snap, item, p);
    if (!d.cover) d.cover = item.cover || '';
    return d;
  }
  async function openNativeChapter(detail, chapter) {
    state.detail = detail;
    detail.chapters = detail.chapters || [];
    var idx = detail.chapters.findIndex(function (c) { return c.url === chapter.url; });
    var prev = idx > 0 ? {
      label: '‹ Prev',
      run: function () { openNativeChapter(detail, detail.chapters[idx - 1]); }
    } : null;
    var next = idx >= 0 && idx < detail.chapters.length - 1 ? {
      label: 'Next ›',
      run: function () { openNativeChapter(detail, detail.chapters[idx + 1]); }
    } : null;
    readerKey = chapter.url;
    readerShell(detail.title, chapter.title, prev, next, '');
    saveProgress({
      source: detail.source, id: detail.id, title: detail.title, cover: detail.cover,
      desc: detail.desc, seriesUrl: detail.url, chapterId: chapter.url,
      chapterLabel: chapter.title, page: 0
    });
    var p = providerById(detail.source);
    try {
      var urls = null;
      if (p.chapter) {
        try { urls = await p.chapter(detail, chapter); } catch (e0) { urls = null; }
      }
      if (!urls || !urls.length) {
        var snap = await nativeSnapshot(p, chapter.url, 'chapter');
        urls = parseNativeChapter(snap, p, chapter.url);
      }
      if (!urls.length) throw new Error('No pages found');
      readerImages(urls, p.ref);
    } catch (e) {
      var body = readerEl && $('#rdRBody', readerEl);
      if (body) body.innerHTML = '<div class="rd-empty" style="margin:60px auto;max-width:520px">This chapter could not be loaded natively from ' +
        esc(sourceName(detail.source)) + '.<br><span style="font-size:12px;color:#6f7681">No external browser is opened. Try another chapter or retry in a moment.</span><br><br>' +
        '<button class="rd-btn gold" type="button" id="rdRClose">Back to chapters</button></div>';
      var b = readerEl && $('#rdRClose', readerEl);
      if (b) b.onclick = function () { closeReader(); };
    }
  }


  var toastTimer = 0;
  function toast(msg) {
    var el = document.getElementById('rdToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'rdToast';
      el.className = 'rd-toast';
      document.body.appendChild(el);
    }
    el.textContent = String(msg || '');
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('on'); }, 2800);
  }

  /* ------------------------------------------------------------------ css */
  function style() {
    if (document.getElementById('sbReaderCss')) return;
    var s = document.createElement('style');
    s.id = 'sbReaderCss';
    s.textContent = [
      '.rd-shell{max-width:1460px;margin:0 auto;padding:8px 0 80px;animation:rdFadeUp .34s cubic-bezier(.16,1,.3,1) both}',
      '@keyframes rdFadeUp{from{opacity:0;transform:translate3d(0,10px,0)}to{opacity:1;transform:translate3d(0,0,0)}}',
      '.rd-hero{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap;margin:0 0 18px;padding:18px 22px;border-radius:20px;background:linear-gradient(135deg,rgba(18,22,32,.84),rgba(11,13,20,.78));border:1px solid rgba(255,255,255,.08);backdrop-filter:blur(18px)}',
      '.rd-shell.rd-adult .rd-hero{background:linear-gradient(135deg,rgba(36,14,26,.86),rgba(14,10,20,.82));border-color:rgba(255,77,125,.26)}',
      '.rd-hero h1{font-size:clamp(26px,3.6vw,40px);line-height:1;letter-spacing:-.04em;margin:0 0 8px;font-weight:900}',
      '.rd-hero h1 em{font-style:normal;color:#f5c518}',
      '.rd-shell.rd-adult .rd-hero h1 em{color:#ff5c8a}',
      '.rd-hero p{color:#9aa2b2;margin:0;max-width:620px;font-size:13.5px;line-height:1.55}',
      '.rd-hero .rd-stat{display:flex;gap:8px;flex-wrap:wrap}',
      '.rd-stat span{border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.04);border-radius:999px;padding:6px 12px;font-size:11px;font-weight:700;color:#b8c0cf;letter-spacing:.03em}',
      '.rd-stat span.safe-pill{border-color:rgba(46,232,138,.32);background:rgba(46,232,138,.1);color:#5cf2a5}',
      '.rd-stat span.adult-pill{border-color:rgba(255,77,125,.38);background:rgba(255,77,125,.14);color:#ff8aad}',
      '.rd-source-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 14px}',
      '.rd-source{display:inline-flex;align-items:center;flex-wrap:wrap;background:rgba(15,18,26,.85);border:1px solid rgba(255,255,255,.09);border-radius:14px;padding:4px;gap:4px}',
      '.rd-source button{border:0;background:transparent;color:#9aa2b2;font-weight:750;font-size:12.5px;padding:8px 15px;border-radius:10px;cursor:pointer;transition:transform .2s cubic-bezier(.16,1,.3,1),background .2s ease,color .2s ease}',
      '.rd-source button:hover{color:#fff}',
      '.rd-source button.on{background:linear-gradient(135deg,#f5c518,#ff9f1c);color:#0b0c0f;box-shadow:0 4px 16px rgba(245,197,24,.28)}',
      '.rd-shell.rd-adult .rd-source button.on{background:linear-gradient(135deg,#ff4d7d,#d946ef);color:#fff;box-shadow:0 4px 18px rgba(255,77,125,.34)}',
      '.rd-source select{border:1px solid rgba(255,255,255,.12);background:#121622;color:#e7e9ee;font-weight:700;font-size:12px;padding:8px 12px;border-radius:10px;cursor:pointer;outline:none;max-width:190px}',
      '.rd-source select option{background:#121419;color:#eceef2}',
      '.rd-tabs{display:inline-flex;gap:4px;background:#111318;border:1px solid #23272f;border-radius:12px;padding:4px;margin:0 0 16px}',
      '.rd-tabs button{border:0;background:transparent;color:#9aa0aa;font-weight:700;font-size:12px;padding:8px 15px;border-radius:9px;cursor:pointer;transition:.16s}',
      '.rd-tabs button.on{background:#2a1b1b;color:#ff8b7a;box-shadow:inset 0 0 0 1px #5c2b2b}',
      '.rd-adult-badge{border:1px solid #5a2424;background:#1c1111;color:#ff9a8b;border-radius:999px;padding:9px 14px;font-size:11.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase}',
      '.rd-tools{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:0 0 14px}',
      '.rd-filters{display:flex;gap:9px;flex-wrap:wrap;align-items:center;margin:0 0 15px}',
      '.rd-filters label{display:flex;align-items:center;gap:8px;background:rgba(16,20,29,.84);border:1px solid rgba(255,255,255,.09);border-radius:12px;padding:7px 11px;font-size:10.5px;font-weight:800;color:#8f96a2;letter-spacing:.05em;text-transform:uppercase}',
      '.rd-filters select{background:transparent;border:0;color:#eceef2;font-size:12.5px;font-weight:650;outline:none;max-width:190px;cursor:pointer}',
      '.rd-filters select option{background:#121419;color:#eceef2}',
      '.rd-filters .rd-btn{padding:8px 12px;font-size:11.5px}',
      '.rd-fnote{color:#7e8697;font-size:11.5px;margin-left:auto}',
      '.rd-search{flex:1 1 320px;display:flex;align-items:center;gap:8px;min-width:240px;padding:5px 6px 5px 14px;border-radius:14px;background:rgba(14,17,25,.88);border:1px solid rgba(255,255,255,.1);transition:border-color .22s ease,box-shadow .22s ease}',
      '.rd-search:focus-within{border-color:rgba(245,197,24,.55);box-shadow:0 0 0 3px rgba(245,197,24,.12)}',
      '.rd-shell.rd-adult .rd-search:focus-within{border-color:rgba(255,77,125,.58);box-shadow:0 0 0 3px rgba(255,77,125,.14)}',
      '.rd-search input{flex:1;background:transparent;border:0;color:#fff;padding:6px 2px;font-size:13.5px;outline:none;min-width:0}',
      '.rd-btn{border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:#eef1f8;border-radius:11px;padding:9px 15px;font-size:12.5px;font-weight:750;cursor:pointer;transition:transform .2s cubic-bezier(.16,1,.3,1),background .2s ease,border-color .2s ease}',
      '.rd-btn:hover{border-color:rgba(255,255,255,.24);background:rgba(255,255,255,.1);transform:translateY(-1px)}',
      '.rd-btn.gold{background:linear-gradient(135deg,#f5c518,#ff9f1c);border-color:transparent;color:#0b0c0f;box-shadow:0 6px 18px rgba(245,197,24,.24)}',
      '.rd-shell.rd-adult .rd-btn.gold{background:linear-gradient(135deg,#ff4d7d,#d946ef);color:#fff;box-shadow:0 6px 20px rgba(255,77,125,.3)}',
      '.rd-btn.ghost{background:transparent}',
      '.rd-rating{display:flex;gap:6px;flex-wrap:wrap}',
      '.rd-rating button{border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.04);color:#9aa2b2;border-radius:999px;padding:8px 14px;font-size:11.5px;font-weight:750;cursor:pointer;transition:.18s ease}',
      '.rd-rating button.on{border-color:rgba(46,232,138,.45);color:#5cf2a5;background:rgba(46,232,138,.1)}',
      '.rd-chips{display:flex;gap:7px;flex-wrap:wrap;margin:0 0 20px}',
      '.rd-chips button{border:1px solid rgba(255,255,255,.09);background:rgba(255,255,255,.035);color:#b9c1d1;border-radius:999px;padding:7px 13px;font-size:12px;font-weight:650;cursor:pointer;white-space:nowrap;transition:transform .18s cubic-bezier(.16,1,.3,1),background .18s ease,color .18s ease}',
      '.rd-chips button:hover{border-color:rgba(255,255,255,.22);color:#fff;transform:translateY(-1px)}',
      '.rd-chips button.on{background:linear-gradient(135deg,#f5c518,#ff9f1c);border-color:transparent;color:#0b0c0f;font-weight:800}',
      '.rd-shell.rd-adult .rd-chips button.on{background:linear-gradient(135deg,#ff4d7d,#d946ef);color:#fff}',
      '.rd-sec{display:flex;align-items:center;justify-content:space-between;gap:14px;margin:0 0 13px}',
      '.rd-sec h2{font-size:17px;font-weight:800;letter-spacing:-.015em;margin:0}',
      '.rd-sec .muted{color:#868e9f;font-size:12px}',
      '.rd-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:16px}',
      '.rd-card{text-align:left;border:0;background:transparent;color:inherit;cursor:pointer;padding:0;min-width:0;transition:transform .32s cubic-bezier(.16,1,.3,1)}',
      '.rd-card:hover{transform:translate3d(0,-6px,0)}',
      '.rd-cover{position:relative;display:block;aspect-ratio:2/3;border-radius:14px;overflow:hidden;background:#12151f;border:1px solid rgba(255,255,255,.08);box-shadow:0 12px 28px rgba(0,0,0,.42);transition:border-color .24s ease,box-shadow .3s ease}',
      '.rd-cover img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .45s cubic-bezier(.16,1,.3,1),opacity .3s}',
      '.rd-card:hover .rd-cover img{transform:scale(1.06)}',
      '.rd-card:hover .rd-cover{border-color:rgba(245,197,24,.5);box-shadow:0 20px 42px rgba(0,0,0,.62),0 0 24px rgba(245,197,24,.15)}',
      '.rd-shell.rd-adult .rd-card:hover .rd-cover{border-color:rgba(255,77,125,.55);box-shadow:0 20px 42px rgba(0,0,0,.65),0 0 24px rgba(255,77,125,.2)}',
      '.rd-badge{position:absolute;left:8px;top:8px;background:rgba(8,10,15,.84);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.14);border-radius:7px;padding:3px 7px;font-size:9.5px;font-weight:800;letter-spacing:.08em;color:#f5c518}',
      '.rd-badge.green{color:#41e88a;border-color:rgba(65,232,138,.32)}',
      '.rd-badge.native{color:#f5c518;border-color:rgba(245,197,24,.34)}',
      '.rd-badge.adult{color:#ff7fa3;border-color:rgba(255,77,125,.42)}',
      '.rd-card b{display:block;font-size:13px;font-weight:750;line-height:1.32;margin:9px 0 3px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
      '.rd-card span{display:block;color:#858d9e;font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.rd-skel .rd-cover{background:linear-gradient(110deg,#12151f 25%,#1e2434 45%,#12151f 65%);background-size:220% 100%;animation:rdShim 1.35s ease-in-out infinite}',
      '@keyframes rdShim{0%{background-position:100% 0}100%{background-position:-120% 0}}',
      '.rd-empty{color:#9199aa;padding:42px 16px;text-align:center;border:1px dashed rgba(255,255,255,.12);border-radius:18px;background:rgba(255,255,255,.02)}',
      '.rd-more{display:flex;justify-content:center;margin:26px 0 0}',
      '.rd-row{display:flex;gap:14px;overflow-x:auto;padding:4px 0 18px;scrollbar-width:thin}',
      '.rd-row .rd-item{flex:0 0 132px}',
      '.rd-row .rd-cover{aspect-ratio:2/3}',
      '.rd-item{text-align:left;border:0;background:transparent;color:inherit;cursor:pointer;padding:0;min-width:0;transition:transform .25s cubic-bezier(.16,1,.3,1)}',
      '.rd-item:hover{transform:translateY(-4px)}',
      '.rd-item .rd-cover{position:relative;border-radius:12px;overflow:hidden;background:#14161b;border:1px solid rgba(255,255,255,.09)}',
      '.rd-item .rd-cover img{width:100%;height:100%;object-fit:cover;display:block}',
      '.rd-item b{display:block;font-size:12.5px;font-weight:700;margin:8px 0 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.rd-item span{display:block;color:#858d9e;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.rd-detail{max-width:1200px;margin:0 auto;padding:4px 0 40px;animation:rdFadeUp .3s cubic-bezier(.16,1,.3,1) both}',
      '.rd-back{border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#eef1f8;border-radius:11px;padding:9px 15px;font-size:12.5px;font-weight:750;cursor:pointer;margin:0 0 20px}',
      '.rd-dhead{display:flex;gap:26px;align-items:flex-start;flex-wrap:wrap;margin:0 0 26px}',
      '.rd-dcover{flex:0 0 210px;max-width:210px;aspect-ratio:2/3;border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,.12);box-shadow:0 22px 54px rgba(0,0,0,.55);background:#14161b}',
      '.rd-dcover img{width:100%;height:100%;object-fit:cover;display:block}',
      '.rd-dinfo{flex:1 1 420px;min-width:260px}',
      '.rd-dinfo h1{font-size:clamp(26px,3.4vw,42px);letter-spacing:-.03em;line-height:1.05;margin:0 0 8px}',
      '.rd-dinfo .by{color:#a8aeb9;font-size:13px;margin:0 0 12px}',
      '.rd-dmeta{display:flex;gap:7px;flex-wrap:wrap;margin:0 0 14px}',
      '.rd-dmeta span{border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.04);color:#c2c9d6;border-radius:999px;padding:5px 11px;font-size:11px}',
      '.rd-desc{color:#b4bac4;font-size:13.5px;line-height:1.65;margin:0 0 18px;max-width:760px;max-height:150px;overflow:auto}',
      '.rd-dactions{display:flex;gap:9px;flex-wrap:wrap;margin:0 0 22px}',
      '.rd-chapbar{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin:0 0 12px}',
      '.rd-chapbar h2{font-size:17px;margin:0}',
      '.rd-chapsearch{background:#11151f;border:1px solid rgba(255,255,255,.12);color:#e8eaee;border-radius:10px;padding:9px 12px;font-size:12.5px;outline:none;min-width:200px}',
      '.rd-chaps{border:1px solid rgba(255,255,255,.09);border-radius:16px;overflow:hidden;background:rgba(14,17,25,.84)}',
      '.rd-chap{display:flex;align-items:center;gap:13px;width:100%;text-align:left;border:0;border-bottom:1px solid rgba(255,255,255,.06);background:transparent;color:inherit;padding:12px 16px;cursor:pointer;transition:background .16s ease}',
      '.rd-chap:last-child{border-bottom:0}',
      '.rd-chap:hover{background:rgba(255,255,255,.06)}',
      '.rd-chap.current{background:rgba(245,197,24,.12)}',
      '.rd-chap .n{flex:0 0 78px;color:#f5c518;font-weight:800;font-size:12.5px;letter-spacing:.02em}',
      '.rd-chap .t{flex:1;min-width:0;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.rd-chap .g{flex:0 0 140px;color:#7d8698;font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:right}',
      '.rd-chap .d{flex:0 0 92px;color:#6c7486;font-size:11px;text-align:right}',
      '.rd-chap .done{color:#2ee88a;font-size:12px;font-weight:800;flex:0 0 auto}',
      '.rd-loading{padding:40px 0;text-align:center;color:#8b919c;font-size:13px}',
      '.rd-spin{display:inline-block;width:18px;height:18px;border:2px solid rgba(255,255,255,.15);border-top-color:#f5c518;border-radius:50%;animation:rdSpin .8s linear infinite;vertical-align:-4px;margin-right:9px}',
      '@keyframes rdSpin{to{transform:rotate(360deg)}}',
      /* Auto-Hiding Floating Multi-Mode Reader Overlay & Chapter Drawer */
      '.rd-reader{position:fixed;inset:0;z-index:160;background:#040508;display:flex;flex-direction:column;animation:rdIn .26s cubic-bezier(.16,1,.3,1) both;overflow:hidden}',
      '@keyframes rdIn{from{opacity:0;transform:scale(.99)}to{opacity:1;transform:none}}',
      '.rd-rbar{position:absolute;top:12px;left:16px;right:16px;z-index:14;display:flex;align-items:center;gap:10px;padding:9px 14px;border-radius:16px;background:rgba(12,15,22,.88);border:1px solid rgba(255,255,255,.12);backdrop-filter:blur(22px);box-shadow:0 14px 40px rgba(0,0,0,.55);transition:opacity .28s ease,transform .32s cubic-bezier(.16,1,.3,1)}',
      '.rd-reader.hud-hidden .rd-rbar{opacity:0;transform:translate3d(0,-120%,0);pointer-events:none}',
      '.rd-rbar button,.rd-toolbar button{border:1px solid rgba(255,255,255,.11);background:rgba(255,255,255,.06);color:#eef1f8;border-radius:10px;min-width:36px;height:36px;font-size:13px;font-weight:750;line-height:1;cursor:pointer;padding:0 11px;transition:transform .16s cubic-bezier(.16,1,.3,1),background .16s ease,border-color .16s ease,color .16s ease}',
      '.rd-rbar button:hover,.rd-toolbar button:hover{background:rgba(255,255,255,.14);border-color:rgba(255,255,255,.22)}',
      '.rd-rbar button:disabled,.rd-toolbar button:disabled{opacity:.32;cursor:default}',
      '.rd-toolbar button.on{background:linear-gradient(135deg,#f5c518,#ff9f1c);color:#0b0c0f;border-color:transparent}',
      '.rd-rtitle{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.rd-rtitle b{font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.rd-rtitle span{font-size:11px;color:#939bad;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.rd-rpages{font-size:11.5px;font-weight:750;font-variant-numeric:tabular-nums;color:#d6dce8;padding:4px 10px;border-radius:999px;background:rgba(255,255,255,.07);white-space:nowrap}',
      '.rd-rbody{flex:1 1 auto;overflow:auto;-webkit-overflow-scrolling:touch;background:#040508;position:relative}',
      /* Webtoon Vertical Continuous */
      '.rd-strip{margin:0 auto;padding:70px 0 96px;display:flex;flex-direction:column;align-items:center;transition:width .2s ease}',
      '.rd-strip img{display:block;width:100%;height:auto;background:#0d0f15;min-height:120px}',
      '.rd-strip.fit-height img{width:auto;max-width:100%;max-height:92vh;object-fit:contain;margin-bottom:8px}',
      /* Single Page & 2-Page Spread Stage */
      '.rd-paged-stage{min-height:100%;display:flex;align-items:center;justify-content:center;padding:74px 20px 104px;position:relative}',
      '.rd-page-frame{display:flex;align-items:center;justify-content:center;gap:10px;max-width:100%;animation:rdPageSlide .26s cubic-bezier(.16,1,.3,1) both}',
      '@keyframes rdPageSlide{from{opacity:0;transform:translate3d(16px,0,0) scale(.985)}to{opacity:1;transform:translate3d(0,0,0) scale(1)}}',
      '.rd-page-frame img{display:block;border-radius:6px;background:#0d0f15;box-shadow:0 18px 50px rgba(0,0,0,.65);transition:width .2s ease,max-height .2s ease}',
      '.rd-paged-stage.fit-width .rd-page-frame img{width:100%;height:auto;max-width:940px}',
      '.rd-paged-stage.fit-height .rd-page-frame img{max-height:calc(100vh - 150px);width:auto;max-width:96vw;object-fit:contain}',
      '.rd-paged-stage.mode-spread .rd-page-frame img{max-width:46vw;max-height:calc(100vh - 150px);width:auto;object-fit:contain}',
      '.rd-paged-stage.mode-spread.fit-width .rd-page-frame img{max-width:48vw;max-height:none;width:47vw;height:auto}',
      '.rd-nav-zone{position:fixed;top:76px;bottom:92px;width:20%;z-index:8;cursor:pointer;background:transparent;border:0;opacity:0}',
      '.rd-nav-zone.prev{left:0}',
      '.rd-nav-zone.next{right:0}',
      '.rd-strip img.rd-on,.rd-page-frame img.rd-on{opacity:1}',
      '.rd-strip img.rd-fail,.rd-page-frame img.rd-fail{min-height:220px;opacity:1}',
      '.rd-rend{max-width:820px;margin:0 auto;padding:24px 20px 110px;text-align:center;color:#939bad;font-size:13px}',
      '.rd-rend button{margin:12px 6px 0}',
      /* Floating Bottom Reader Toolbar */
      '.rd-toolbar{position:absolute;left:50%;bottom:18px;transform:translate3d(-50%,0,0);z-index:15;display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:center;max-width:calc(100vw - 24px);padding:8px 12px;border-radius:18px;background:rgba(12,15,22,.9);border:1px solid rgba(255,255,255,.14);backdrop-filter:blur(24px);box-shadow:0 18px 48px rgba(0,0,0,.68);transition:opacity .28s ease,transform .32s cubic-bezier(.16,1,.3,1)}',
      '.rd-reader.hud-hidden .rd-toolbar{opacity:0;transform:translate3d(-50%,130%,0);pointer-events:none}',
      '.rd-tb-group{display:inline-flex;align-items:center;gap:4px;padding:3px;border-radius:12px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07)}',
      '.rd-tb-group button{height:30px;min-width:30px;padding:0 10px;font-size:11.5px;border:0;background:transparent}',
      '.rd-tb-sep{width:1px;height:20px;background:rgba(255,255,255,.12);margin:0 2px}',
      '.rd-zoom-lbl{font-size:11px;font-weight:800;font-variant-numeric:tabular-nums;color:#d6dce8;min-width:40px;text-align:center}',
      '.rd-page-scrub{display:inline-flex;align-items:center;gap:6px;padding:0 6px}',
      '.rd-page-scrub input{width:96px;accent-color:#f5c518;cursor:pointer}',
      /* Slide-Out Chapter Drawer */
      '.rd-drawer-bg{position:absolute;inset:0;z-index:20;background:rgba(4,5,9,.6);backdrop-filter:blur(8px);opacity:0;pointer-events:none;transition:opacity .26s ease}',
      '.rd-drawer-bg.open{opacity:1;pointer-events:auto}',
      '.rd-drawer{position:absolute;top:12px;right:12px;bottom:12px;width:min(360px,calc(100vw - 24px));z-index:22;display:flex;flex-direction:column;border-radius:20px;background:rgba(14,17,25,.97);border:1px solid rgba(255,255,255,.14);backdrop-filter:blur(26px);box-shadow:-20px 0 60px rgba(0,0,0,.72);transform:translate3d(110%,0,0);transition:transform .36s cubic-bezier(.16,1,.3,1);overflow:hidden}',
      '.rd-drawer.open{transform:translate3d(0,0,0)}',
      '.rd-drawer-head{display:flex;align-items:center;justify-content:space-between;padding:16px 16px 12px;border-bottom:1px solid rgba(255,255,255,.08)}',
      '.rd-drawer-head b{font-size:15px;font-weight:850}',
      '.rd-drawer-search{margin:10px 14px;background:#0d1018;border:1px solid rgba(255,255,255,.12);color:#fff;border-radius:10px;padding:9px 12px;font-size:12.5px;outline:none}',
      '.rd-drawer-list{flex:1 1 auto;overflow-y:auto;padding:4px 10px 14px}',
      '.rd-drawer-item{display:flex;align-items:center;gap:10px;width:100%;text-align:left;border:1px solid transparent;background:transparent;color:#dce2ef;padding:10px 11px;border-radius:11px;font-size:12.5px;cursor:pointer;margin-bottom:4px;transition:background .16s ease,border-color .16s ease}',
      '.rd-drawer-item:hover{background:rgba(255,255,255,.06)}',
      '.rd-drawer-item.on{background:rgba(245,197,24,.14);border-color:rgba(245,197,24,.45);color:#f5c518;font-weight:750}',
      '.rd-drawer-item span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.rd-rprog{position:absolute;left:0;right:0;bottom:0;height:3px;background:rgba(255,255,255,.08);z-index:16}',
      '.rd-rprog i{display:block;height:100%;width:0%;background:linear-gradient(90deg,#f5c518,#2ee88a);transition:width .16s linear}',
      '.rd-toast{position:fixed;left:50%;bottom:28px;transform:translate(-50%,14px);z-index:260;background:rgba(20,24,35,.96);border:1px solid rgba(255,255,255,.16);color:#f0f2f5;padding:11px 17px;border-radius:12px;font-size:12.5px;opacity:0;pointer-events:none;transition:.22s;max-width:88vw;text-align:center}',
      '.rd-toast.on{opacity:1;transform:translate(-50%,0)}',
      'body.rd-lock{overflow:hidden!important}',
      '@media(max-width:720px){.rd-hero{padding:14px 16px}.rd-grid{grid-template-columns:repeat(auto-fill,minmax(122px,1fr));gap:10px}.rd-paged-stage.mode-spread .rd-page-frame img{max-width:94vw}.rd-rbar{top:8px;left:8px;right:8px;padding:7px 10px}.rd-toolbar{bottom:10px;padding:6px 8px}.rd-tb-sep,.rd-page-scrub{display:none}}',
      '@media(prefers-reduced-motion:reduce){.rd-shell,.rd-detail,.rd-reader,.rd-page-frame,.rd-rbar,.rd-toolbar,.rd-drawer,.rd-card{animation:none!important;transition:none!important}}'
    ].join('\n');
    document.head.appendChild(s);
  }

  /* ----------------------------------------------------------------- paint */
  function optionHtml(list, value) {
    return list.map(function (o) {
      return '<option value="' + esc(o.c) + '"' + (o.c === value ? ' selected' : '') + '>' + esc(o.n) + '</option>';
    }).join('');
  }
  function shellHtml() {
    var native = isNativeSource(state.source);
    var safeList = safeProviders();
    var quickNative = safeList.slice(0, 4);
    var moreNative = safeList.slice(4);
    var nativeOpts = moreNative.map(function (p) {
      return '<option value="' + p.id + '"' + (state.source === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>';
    }).join('');
    var placeholder = state.source === 'md' ? 'Search manga, manhwa, titles...'
      : state.source === 'wt' ? 'Search WEBTOON series...'
        : 'Search ' + sourceName(state.source) + '...';
    var note = state.source === 'md'
      ? 'Showing kid-safe titles with ' + esc(langLabel(state.lang)) + ' chapters'
      : state.source === 'wt'
        ? 'WEBTOON catalogue: ' + esc(WT_LOCALES[state.lang] ? langLabel(state.lang) : 'English')
        : esc(sourceName(state.source)) + ' · English chapters · native reader';
    var langFilter = native
      ? '<label>Language<select id="rdLang" aria-label="Reading language" disabled><option>English</option></select></label>'
      : '<label>Language<select id="rdLang" aria-label="Reading language">' + optionHtml(LANGUAGES, state.lang) + '</select></label>';
    if (state.adultMode) {
      var ap = providerById(state.source) || ADULT_PROVIDERS[0];
      var srcBtns = ADULT_PROVIDERS.map(function (x) {
        return '<button data-rd-source="' + x.id + '" role="tab" aria-selected="' + (state.source === x.id) +
          '" class="' + (state.source === x.id ? 'on' : '') + '">' + esc(x.name) + '</button>';
      }).join('');
      var tabBtns = (ap.tabs || []).map(function (t) {
        return '<button type="button" data-rd-tab="' + t.c + '" class="' + (state.tab === t.c ? 'on' : '') + '">' + esc(t.n) + '</button>';
      }).join('');
      return '<div class="rd-shell rd-adult">' +
        '<div class="rd-hero"><div><h1>18+ <em>Reading</em></h1>' +
        '<p>Adult manga and doujinshi from Hentai20 and nHentai. This room is isolated from the general Reading room, stays inside the 18+ vault, and is never shown in Kids or All Ages mode.</p></div>' +
        '<div class="rd-stat"><span>18+ only</span><span>English only</span><span>VPN routed</span><span>Native reader</span></div></div>' +
        '<div class="rd-source" role="tablist">' + srcBtns + '</div>' +
        (tabBtns ? '<div class="rd-tabs" role="group" aria-label="Catalogue">' + tabBtns + '</div>' : '') +
        '<div class="rd-tools"><form class="rd-search" id="rdForm" data-scoped-search="adult-reading">' +
        '<input id="rdSearch" type="search" autocomplete="off" placeholder="' + esc(placeholder) + '" value="' + esc(state.q) + '">' +
        '<button class="rd-btn gold" type="submit">Search</button></form>' +
        '<span class="rd-adult-badge">Age-gated · 18+</span></div>' +
        '<div class="rd-filters">' +
        langFilter +
        '<button type="button" class="rd-btn ghost" id="rdReset">Reset filters</button>' +
        '<span class="rd-fnote">' + note + ' · strict English metadata</span>' +
        '</div>' +
        '<div class="rd-chips" id="rdChips"></div>' +
        '<div id="rdBody"></div></div>';
    }
    return '<div class="rd-shell" data-reading-mode="safe">' +
      '<div class="rd-hero"><div><h1>Reading <em>Room</em></h1>' +
      '<p>Manga, manhwa and webcomics across native providers with Webtoon, Single Page, and 2-Page Spread reading modes. Strictly family-safe with zero 18+ content.</p></div>' +
      '<div class="rd-stat"><span class="safe-pill">Kid-Safe Catalog</span><span>3 Reader Modes</span><span>VPN routed</span><span>Offline cache</span></div></div>' +
      '<div class="rd-source-bar"><div class="rd-source" role="tablist" aria-label="Reading sources">' +
      '<button data-rd-source="md" role="tab" aria-selected="' + (state.source === 'md') + '" class="' + (state.source === 'md' ? 'on' : '') + '">MangaDex</button>' +
      '<button data-rd-source="wt" role="tab" aria-selected="' + (state.source === 'wt') + '" class="' + (state.source === 'wt' ? 'on' : '') + '">WEBTOON</button>' +
      quickNative.map(function (p) {
        return '<button data-rd-source="' + p.id + '" role="tab" aria-selected="' + (state.source === p.id) + '" class="' + (state.source === p.id ? 'on' : '') + '">' + esc(p.name) + '</button>';
      }).join('') +
      '<select id="rdSourceSel" aria-label="More reading sources"><option value="">More sources…</option>' + nativeOpts + '</select>' +
      '</div></div>' +
      '<div class="rd-tools"><form class="rd-search" id="rdForm" data-scoped-search="reading">' +
      '<input id="rdSearch" type="search" autocomplete="off" placeholder="' + esc(placeholder) + '" value="' + esc(state.q) + '">' +
      '<button class="rd-btn gold" type="submit">Search</button></form>' +
      '<div class="rd-rating" role="group" aria-label="Reading filter">' +
      '<button data-rd-rating="safe" class="' + (state.rating === 'safe' ? 'on' : '') + '">All ages</button>' +
      '<button data-rd-rating="teen" class="' + (state.rating === 'teen' ? 'on' : '') + '">Teen</button>' +
      '</div></div>' +
      '<div class="rd-filters">' +
      langFilter +
      '<label>' + (state.source === 'md' ? 'Type' : 'Format') + '<select id="rdType" aria-label="Title type"' + (native ? ' disabled' : '') + '>' + optionHtml(typesForSource(), state.type) + '</select></label>' +
      '<button type="button" class="rd-btn ghost" id="rdReset">Reset filters</button>' +
      '<span class="rd-fnote">' + note + '</span>' +
      '</div>' +
      '<div class="rd-chips" id="rdChips"></div>' +
      '<div id="rdBody"></div></div>';
  }

  function genreChips() {
    if (state.adultMode) {
      var ap = providerById(state.source);
      return [{ g: '', n: 'All genres' }].concat((ap && ap.genres) || []);
    }
    if (state.source === 'md') {
      var list = MD_TAGS ? MD_GENRES.filter(function (g) {
        return MD_TAGS.some(function (t) { return t.n.toLowerCase() === g.toLowerCase(); });
      }) : [];
      return [{ g: '', n: 'All genres' }].concat(list.map(function (g) { return { g: g, n: g }; }));
    }
    if (state.source === 'wt') {
      return [{ g: '', n: 'All genres' }].concat(WT_GENRES.map(function (g) { return { g: g.s, n: g.n }; }));
    }
    return [];
  }
  function paintChips() {
    var box = root && $('#rdChips', root);
    if (!box) return;
    var list = genreChips();
    box.innerHTML = list.map(function (g) {
      return '<button type="button" data-rd-genre="' + esc(g.g) + '" class="' + (state.genre === g.g ? 'on' : '') + '">' + esc(g.n) + '</button>';
    }).join('');
  }

  function cardHtml(it) {
    var native = isNativeSource(it.source);
    var badge = it.source === 'md' ? 'MD' : it.source === 'wt' ? (it.adult ? '18+' : 'WT') : sourceShort(it.source);
    var sub = it.source === 'md'
      ? [it.year, it.status, (it.tags || []).slice(0, 2).join(' · ')].filter(Boolean).join(' · ')
      : it.source === 'wt'
        ? (it.genre || it.author || 'WEBTOON')
        : [sourceName(it.source), it.adult ? '18+' : 'English'].filter(Boolean).join(' · ');
    return '<button class="rd-card" type="button" data-rd-open="' + it.source + ':' + esc(it.id) + '">' +
      '<span class="rd-cover"><img loading="lazy" decoding="async" src="' + esc(img(it.cover, nativeRef(it.source))) + '" alt="' + esc(it.title) + '" onerror="this.style.display=\'none\'">' +
      '<span class="rd-badge' + (it.source === 'wt' ? ' green' : native ? ' native' : '') + '">' + esc(badge) + '</span></span>' +
      '<b>' + esc(it.title) + '</b><span>' + esc(sub || ' ') + '</span></button>';
  }
  function skeletonHtml(n) {
    var out = '';
    for (var i = 0; i < n; i++) out += '<div class="rd-card rd-skel"><span class="rd-cover"></span><b>&nbsp;</b><span>&nbsp;</span></div>';
    return out;
  }
  function historyRow() {
    /* General Reading never surfaces an adult title, cover or source, even
       from the continue-reading shelf. */
    var list = history().filter(function (h) {
      if (state.adultMode) return true;
      return h.source === 'md' || h.source === 'wt' || isNativeSource(h.source);
    }).slice(0, 12);
    if (!list.length) return '';
    return '<div class="rd-sec"><h2>Continue reading</h2><span class="muted">' + list.length + ' title' + (list.length === 1 ? '' : 's') + '</span></div>' +
      '<div class="rd-row">' + list.map(function (h) {
        return '<button class="rd-item" type="button" data-rd-hist="' + esc(h.source + ':' + h.id) + '">' +
          '<span class="rd-cover"><img loading="lazy" decoding="async" src="' + esc(img(h.cover)) + '" alt="' + esc(h.title) + '" onerror="this.style.display=\'none\'"></span>' +
          '<b>' + esc(h.title) + '</b><span>' + esc(h.chapterLabel || ('Episode ' + (h.ep || ''))) + '</span></button>';
      }).join('') + '</div>';
  }

  function paintBody() {
    var body = root && $('#rdBody', root);
    if (!body) return;
    if (state.view === 'detail') { paintDetail(body); return; }
    var native = isNativeSource(state.source);
    var label = sourceName(state.source);
    var head = historyRow();
    if (state.loading && !state.items.length) {
      body.innerHTML = head + '<div class="rd-sec"><h2>' + esc(label + ' catalogue') + '</h2><span class="muted">Loading · ' + esc(native ? 'English' : langLabel(state.lang)) + '</span></div><div class="rd-grid">' + skeletonHtml(12) + '</div>';
      return;
    }
    if (!state.items.length) {
      var filtered = !!(state.q || state.genre || state.type || (!native && state.lang !== 'en'));
      var why = state.q
        ? 'Nothing matched that search' + (native ? ' on ' + esc(label) : ' in ' + esc(langLabel(state.lang))) + '.'
        : native
          ? 'No titles are visible on ' + esc(label) + ' right now.'
          : 'No ' + esc(langLabel(state.lang)) + ' titles for this filter yet.';
      body.innerHTML = head + '<div class="rd-empty">' + why +
        '<br><span style="font-size:12px;color:#6f7681">' + (native ? 'Try the search above or pick another provider.' : 'Try another language, type or genre.') + '</span>' +
        (filtered ? '<div class="rd-more"><button class="rd-btn" type="button" data-rd-reset="1">Reset filters</button></div>' : '') +
        '</div>';
      return;
    }
    var heading;
    if (state.q) heading = 'Results for “' + esc(state.q) + '”';
    else if (state.source === 'md') heading = ['Popular on MangaDex', state.type ? typeLabel(state.type) : '', esc(state.genre || ''), state.lang !== 'en' ? langLabel(state.lang) : ''].filter(Boolean).join(' · ');
    else if (state.source === 'wt') heading = ['WEBTOON', state.type === 'canvas' ? 'Canvas' : 'Originals', esc(state.genre || ''), WT_LOCALES[state.lang] ? langLabel(state.lang) : 'English'].filter(Boolean).join(' · ');
    else heading = esc(label + ' · English catalogue' + (state.genre ? ' · ' + state.genre : ''));
    body.innerHTML = head +
      '<div class="rd-sec"><h2>' + heading + '</h2>' +
      '<span class="muted">' + (state.total ? state.total + ' titles' : state.items.length + ' titles') + '</span></div>' +
      '<div class="rd-grid">' + state.items.map(cardHtml).join('') + '</div>' +
      (state.loading ? '<div class="rd-loading"><span class="rd-spin"></span>Loading more</div>' : '') +
      (state.more ? '<div class="rd-more"><button class="rd-btn" type="button" id="rdMore">Load more</button></div>' : '');
    var more = $('#rdMore', body);
    if (more) more.onclick = function () {
      if (state.loading) return;
      if (state.source === 'md') mdLoad(true);
      else if (state.source === 'wt') toast('Open a genre on WEBTOON for the full list');
      else nativeLoad(true);
    };
  }

  /* ---------------------------------------------------------------- detail */
  function detailUnit(d) {
    return d.source === 'md' || isNativeSource(d.source) ? 'Chapters' : 'Episodes';
  }
  function detailActions() {
    var d = state.detail;
    if (!d) return '';
    var native = isNativeSource(d.source);
    var prog = progressOf(d.source, d.id);
    var label = '';
    if (prog && prog.chapterLabel && (d.source === 'md' || native)) label = 'Continue · ' + prog.chapterLabel;
    if (prog && prog.ep && d.source === 'wt') label = 'Continue · Episode ' + prog.ep;
    return '<div class="rd-dactions">' +
      (label ? '<button class="rd-btn gold" type="button" data-rd-continue="1">' + esc(label) + '</button>' : '') +
      '<button class="rd-btn" type="button" data-rd-first="1">' + (d.source === 'wt' ? 'Read episode 1' : 'Read first chapter') + '</button>' +
      '</div>';
  }
  function paintDetail(body) {
    var d = state.detail;
    if (!d) { state.view = 'browse'; paintBody(); return; }
    var native = isNativeSource(d.source);
    var tags = (d.tags || []).map(function (t) { return '<span>' + esc(t) + '</span>'; }).join('');
    body.innerHTML = '<div class="rd-detail"><button class="rd-back" type="button" id="rdBack">← Back to reading</button>' +
      '<div class="rd-dhead"><div class="rd-dcover"><img src="' + esc(img(d.cover, d.ref || nativeRef(d.source))) + '" alt="' + esc(d.title) + '" onerror="this.style.display=\'none\'"></div>' +
      '<div class="rd-dinfo"><h1>' + esc(d.title) + '</h1>' +
      '<p class="by">' + esc(d.author || sourceName(d.source)) + (d.genre ? ' · ' + esc(d.genre) : '') + '</p>' +
      '<div class="rd-dmeta">' + (d.year ? '<span>' + esc(d.year) + '</span>' : '') + (d.status ? '<span>' + esc(d.status) + '</span>' : '') +
      '<span>' + esc(sourceName(d.source)) + '</span>' + (native ? '<span>English</span>' : '') + '</div>' +
      (d.desc ? '<p class="rd-desc">' + esc(d.desc) + '</p>' : '') +
      (tags ? '<div class="rd-dmeta">' + tags + '</div>' : '') +
      detailActions() + '</div></div>' +
      '<div class="rd-chapbar"><h2>' + detailUnit(d) + '</h2>' +
      '<input class="rd-chapsearch" id="rdChapSearch" type="search" placeholder="Filter ' + detailUnit(d).toLowerCase() + '..." /></div>' +
      '<div id="rdChapList"></div></div>';
    var back = $('#rdBack', body);
    if (back) back.onclick = function () { state.view = 'browse'; state.detail = null; paint(); };
    var first = $('[data-rd-first]', body);
    if (first) first.onclick = function () { openFirst(d); };
    var cont = $('[data-rd-continue]', body);
    if (cont) cont.onclick = function () { continueReading(d); };
    var filter = $('#rdChapSearch', body);
    if (filter) filter.oninput = function () { paintChapters(filter.value); };
    if (d.source === 'md') {
      if (!d.chapters) {
        $('#rdChapList', body).innerHTML = '<div class="rd-loading"><span class="rd-spin"></span>Loading chapters</div>';
        mdFeed(d, 0, false).then(function () {
          paintChapters('');
        }).catch(function () {
          $('#rdChapList', body).innerHTML = '<div class="rd-empty">Chapters could not be loaded. Try again in a moment.</div>';
        });
      } else paintChapters('');
    } else if (native) {
      paintChapters('');
    } else {
      paintChapters('');
    }
  }
  function paintChapters(filter) {
    var body = root && $('#rdBody', root);
    var host = body && $('#rdChapList', body);
    if (!host) return;
    var d = state.detail;
    var prog = progressOf(d.source, d.id);
    var f = String(filter || '').toLowerCase();
    if (d.source === 'md') {
      if (d.emptyFeed) {
        host.innerHTML = '<div class="rd-empty">No ' + esc(langLabel(d.feedLang || state.lang)) + ' chapters available.</div>';
        return;
      }
      var list = (d.chapters || []).filter(function (c) {
        if (!f) return true;
        return ('ch ' + c.chapter + ' ' + c.title + ' ' + c.group).toLowerCase().indexOf(f) >= 0;
      });
      host.innerHTML = '<div class="rd-chaps">' + list.slice(0, 400).map(function (c) {
        var label = c.chapter ? 'Ch. ' + c.chapter : 'Oneshot';
        var done = prog && prog.chapterId === c.id;
        return '<button class="rd-chap" type="button" data-rd-chap="' + esc(c.id) + '">' +
          '<span class="n">' + esc(label) + '</span><span class="t">' + esc(c.title || 'Chapter ' + c.chapter) + '</span>' +
          '<span class="g">' + esc((c.group ? c.group + ' · ' : '') + String(c.lang || 'en').toUpperCase()) + '</span><span class="d">' + esc(fmtDate(c.date)) + '</span>' +
          (done ? '<span class="done">✓</span>' : '') + '</button>';
      }).join('') + '</div>' +
        (list.length > 400 ? '<div class="rd-loading">Showing the newest 400. Use the filter to find older chapters.</div>' : '') +
        (d.feedOffset < d.feedTotal ? '<div class="rd-more"><button class="rd-btn" type="button" id="rdMoreChap">Load older chapters</button></div>' : '');
      var more = $('#rdMoreChap', host);
      if (more) more.onclick = function () {
        more.disabled = true;
        more.textContent = 'Loading...';
        mdFeed(d, d.feedOffset || 0, true).then(function () { paintChapters(filter); }).catch(function () { more.disabled = false; more.textContent = 'Retry'; });
      };
    } else if (d.source === 'wt') {
      var eps = (d.episodes || []).filter(function (e) {
        if (!f) return true;
        return ('ep ' + e.no + ' ' + e.title).toLowerCase().indexOf(f) >= 0;
      });
      host.innerHTML = '<div class="rd-chaps">' + eps.map(function (e) {
        var done = prog && Number(prog.ep) === Number(e.no);
        return '<button class="rd-chap" type="button" data-rd-ep="' + e.no + '">' +
          '<span class="n">EP ' + e.no + '</span><span class="t">' + esc(e.title) + '</span>' +
          '<span class="g">WEBTOON</span><span class="d">' + esc(e.date || '') + '</span>' +
          (done ? '<span class="done">✓</span>' : '') + '</button>';
      }).join('') + '</div>' +
        (d.more ? '<div class="rd-more"><button class="rd-btn" type="button" id="rdMoreEp">Load older episodes</button></div>' : '');
      var more = $('#rdMoreEp', host);
      if (more) more.onclick = function () {
        more.disabled = true;
        more.textContent = 'Loading...';
        wtMoreEpisodes(d).then(function () { paintChapters(filter); }).catch(function () { more.disabled = false; more.textContent = 'Retry'; });
      };
    } else {
      var chapters = (d.chapters || []).filter(function (c) {
        if (!f) return true;
        return ('ch ' + (c.no || '') + ' ' + (c.title || '')).toLowerCase().indexOf(f) >= 0;
      });
      if (!chapters.length) {
        host.innerHTML = '<div class="rd-empty">' +
          ((d.chapters && d.chapters.length) ? 'No chapters match that filter.' : 'No English chapters available.') +
          '</div>';
        return;
      }
      host.innerHTML = '<div class="rd-chaps">' + chapters.map(function (c) {
        var done = prog && (prog.chapterId === c.url || prog.chapterId === c.id);
        var no = c.no && c.no < 1e9 ? 'Ch. ' + c.no : 'Ch.';
        var t = String(c.title || '').replace(/^(?:chapter|ch\.?)\s*[\d.]+\s*[-:·]?\s*/i, '') || 'English release';
        return '<button class="rd-chap" type="button" data-rd-nchap="' + esc(c.url || c.id) + '">' +
          '<span class="n">' + esc(no) + '</span><span class="t">' + esc(t) + '</span>' +
          '<span class="g">EN</span><span class="d">' + esc(sourceShort(d.source)) + '</span>' +
          (done ? '<span class="done">✓</span>' : '') + '</button>';
      }).join('') + '</div>';
    }
    host.onclick = function (e) {
      var b = e.target.closest('[data-rd-chap]');
      if (b && d.source === 'md') {
        var id = b.getAttribute('data-rd-chap');
        var ch = (d.chapters || []).filter(function (c) { return c.id === id; })[0];
        if (ch) openMdChapter(d, ch);
        return;
      }
      var epb = e.target.closest('[data-rd-ep]');
      if (epb && d.source === 'wt') {
        var no = parseInt(epb.getAttribute('data-rd-ep'), 10);
        var ep = (d.episodes || []).filter(function (x) { return Number(x.no) === no; })[0];
        if (ep) openWtChapter(d, ep);
        return;
      }
      var nb = e.target.closest('[data-rd-nchap]');
      if (nb && isNativeSource(d.source)) {
        var cu = nb.getAttribute('data-rd-nchap');
        var nc = (d.chapters || []).filter(function (x) { return (x.url || x.id) === cu; })[0];
        if (nc) openNativeChapter(d, nc);
      }
    };
  }

  function openFirst(d) {
    if (d.source === 'md') {
      if (!d.chapters || !d.chapters.length) { toast('Chapters are still loading'); return; }
      var ch = d.chapters[d.chapters.length - 1];
      openMdChapter(d, ch);
    } else if (d.source === 'wt') {
      var ep = { no: 1, title: 'Episode 1', url: wtSeriesUrlFrom(d.url, 1) };
      openWtChapter(d, ep);
    } else {
      if (!d.chapters || !d.chapters.length) { toast('No English chapters available.'); return; }
      openNativeChapter(d, d.chapters[0]);
    }
  }
  function continueReading(d) {
    var p = progressOf(d.source, d.id);
    if (!p) { openFirst(d); return; }
    if (d.source === 'md') {
      var ch = (d.chapters || []).filter(function (c) { return c.id === p.chapterId; })[0];
      if (ch) { openMdChapter(d, ch); return; }
      toast('Chapter list is still loading');
      if (d.chapters) { openFirst(d); return; }
      mdFeed(d, 0, false).then(function () { continueReading(d); }).catch(function () { openFirst(d); });
    } else if (d.source === 'wt') {
      var ep = (d.episodes || []).filter(function (e) { return Number(e.no) === Number(p.ep); })[0] ||
        { no: Number(p.ep) || 1, title: 'Episode ' + (p.ep || 1), url: wtSeriesUrlFrom(d.url, p.ep || 1) };
      openWtChapter(d, ep);
    } else {
      var nc = (d.chapters || []).filter(function (c) { return (c.url || c.id) === p.chapterId; })[0];
      if (nc) openNativeChapter(d, nc);
      else openFirst(d);
    }
  }
  function openFromHistory(key) {
    var parts = String(key || '').split(':');
    var source = parts[0];
    var id = parts.slice(1).join(':');
    var h = history().filter(function (x) { return x.source === source && x.id === id; })[0];
    if (!h) return;
    if (source === 'md') {
      state.detail = {
        source: 'md', id: h.id, title: h.title, cover: h.cover, desc: h.desc || '',
        tags: h.tags || [], year: h.year || '', status: h.status || '', author: h.author || ''
      };
    } else if (source === 'wt') {
      state.detail = {
        source: 'wt', id: h.id, title: h.title, cover: h.cover, desc: h.desc || '',
        tags: [], url: h.seriesUrl, episodes: [], more: false, page: 1
      };
    } else if (isNativeSource(source)) {
      state.detail = {
        source: source, id: h.id, title: h.title, cover: h.cover, desc: h.desc || '',
        tags: [], url: h.seriesUrl || '', ref: nativeRef(source), chapters: [], chapterMode: 'native'
      };
    } else return;
    state.view = 'detail';
    paint();
    if (source === 'wt' && h.seriesUrl) {
      wtSeries(h.seriesUrl).then(function (s) {
        s.id = h.id;
        state.detail = s;
        if (state.view === 'detail') paint();
      }).catch(function () {});
    } else if (isNativeSource(source)) {
      nativeDetail(state.detail).then(function (d) {
        d.id = h.id;
        if (state.view === 'detail') { state.detail = d; paint(); }
      }).catch(function () {});
    }
  }

  /* ---------------------------------------------------------------- reader */
  /* MangaDex feeds arrive newest-first. "Next" therefore walks toward a
     higher chapter number (a lower index) and "Prev" walks back. */
  function readerNav(d, idx) {
    var chs = d.chapters || [];
    if (idx >= 0 && idx < chs.length - 1) {
      return { label: '‹ Prev', run: function () { openMdChapter(d, chs[idx + 1]); } };
    }
    return null;
  }
  function readerNext(d, idx) {
    var chs = d.chapters || [];
    if (idx > 0) {
      return { label: 'Next ›', run: function () { openMdChapter(d, chs[idx - 1]); } };
    }
    return null;
  }
  var readerSession = { urls: [], ref: '', pageIdx: 0, prev: null, next: null, hudTimer: 0, drawerOpen: false };
  var readerKeyHandler = null;

  function buildSpreadPairs(total) {
    var pairs = [];
    if (total <= 0) return pairs;
    pairs.push([0]);
    for (var i = 1; i < total; i += 2) {
      if (i + 1 < total) pairs.push([i, i + 1]);
      else pairs.push([i]);
    }
    return pairs;
  }

  function showReaderHud(keepOpen) {
    if (!readerEl) return;
    readerEl.classList.remove('hud-hidden');
    clearTimeout(readerSession.hudTimer);
    if (!keepOpen && !readerSession.drawerOpen) {
      readerSession.hudTimer = setTimeout(function () {
        if (readerEl && !readerSession.drawerOpen) readerEl.classList.add('hud-hidden');
      }, 3000);
    }
  }
  function toggleReaderHud() {
    if (!readerEl) return;
    if (readerEl.classList.contains('hud-hidden')) showReaderHud(false);
    else {
      clearTimeout(readerSession.hudTimer);
      readerEl.classList.add('hud-hidden');
    }
  }
  function setChapterDrawer(open) {
    if (!readerEl) return;
    readerSession.drawerOpen = !!open;
    var bg = $('#rdDrawerBg', readerEl);
    var dr = $('#rdChapDrawer', readerEl);
    if (bg) bg.classList.toggle('open', !!open);
    if (dr) dr.classList.toggle('open', !!open);
    if (open) {
      showReaderHud(true);
      renderDrawerChapters('');
    } else {
      showReaderHud(false);
    }
  }
  function renderDrawerChapters(filter) {
    if (!readerEl || !state.detail) return;
    var listEl = $('#rdDrawerList', readerEl);
    if (!listEl) return;
    var d = state.detail;
    var f = String(filter || '').toLowerCase();
    var items = [];
    if (d.source === 'md') {
      items = (d.chapters || []).map(function (c) {
        return {
          key: c.id,
          label: (c.chapter ? 'Ch. ' + c.chapter : 'Oneshot') + (c.title ? ' · ' + c.title : ''),
          active: readerKey === c.id,
          run: function () { setChapterDrawer(false); openMdChapter(d, c); }
        };
      });
    } else if (d.source === 'wt') {
      items = (d.episodes || []).map(function (ep) {
        return {
          key: 'ep' + ep.no,
          label: 'Ep. ' + ep.no + (ep.title ? ' · ' + ep.title : ''),
          active: readerKey === ('ep' + ep.no),
          run: function () { setChapterDrawer(false); openWtChapter(d, ep); }
        };
      });
    } else {
      items = (d.chapters || []).map(function (c) {
        return {
          key: c.url || c.id,
          label: (c.no && c.no < 1e9 ? 'Ch. ' + c.no + ' · ' : '') + (c.title || 'Chapter'),
          active: readerKey === (c.url || c.id),
          run: function () { setChapterDrawer(false); openNativeChapter(d, c); }
        };
      });
    }
    var filtered = items.filter(function (x) { return !f || x.label.toLowerCase().indexOf(f) >= 0; });
    if (!filtered.length) {
      listEl.innerHTML = '<div class="rd-empty" style="padding:24px 10px">No chapters match.</div>';
      return;
    }
    listEl.innerHTML = '';
    filtered.slice(0, 300).forEach(function (it) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'rd-drawer-item' + (it.active ? ' on' : '');
      b.innerHTML = '<span>' + esc(it.label) + '</span>';
      b.onclick = it.run;
      listEl.appendChild(b);
    });
  }

  function readerShell(title, sub, prev, next, pages) {
    closeReader();
    style();
    readerSession = { urls: [], ref: '', pageIdx: 0, prev: prev || null, next: next || null, hudTimer: 0, drawerOpen: false };
    readerEl = document.createElement('div');
    readerEl.className = 'rd-reader';
    readerEl.setAttribute('data-reader-mode', state.readerMode);
    readerEl.innerHTML =
      '<div class="rd-rbar" id="rdRTop">' +
      '<button type="button" id="rdRBack" aria-label="Back">←</button>' +
      '<div class="rd-rtitle"><b>' + esc(title) + '</b><span>' + esc(sub) + '</span></div>' +
      '<div class="rd-rpages" id="rdRPages">' + esc(pages || 'Loading…') + '</div>' +
      '<button type="button" id="rdDrawerBtn" title="Chapters Drawer">Chapters</button>' +
      '<button type="button" id="rdRPrev"' + (prev ? '' : ' disabled') + ' title="Previous Chapter">‹</button>' +
      '<button type="button" id="rdRNext"' + (next ? '' : ' disabled') + ' title="Next Chapter">›</button>' +
      '</div>' +
      '<div class="rd-rbody" id="rdRBody"><div class="rd-loading" style="padding-top:110px"><span class="rd-spin"></span>Loading pages</div></div>' +
      '<div class="rd-toolbar" id="rdToolbar" role="toolbar" aria-label="Reader controls">' +
      '<div class="rd-tb-group" role="group" aria-label="Reading mode">' +
      '<button type="button" data-rd-mode="webtoon" class="' + (state.readerMode === 'webtoon' ? 'on' : '') + '">Webtoon</button>' +
      '<button type="button" data-rd-mode="single" class="' + (state.readerMode === 'single' ? 'on' : '') + '">Single</button>' +
      '<button type="button" data-rd-mode="spread" class="' + (state.readerMode === 'spread' ? 'on' : '') + '">2-Page</button>' +
      '</div>' +
      '<span class="rd-tb-sep"></span>' +
      '<div class="rd-tb-group" role="group" aria-label="Fit mode">' +
      '<button type="button" data-rd-fit="width" class="' + (state.fitMode === 'width' ? 'on' : '') + '">Fit Width</button>' +
      '<button type="button" data-rd-fit="height" class="' + (state.fitMode === 'height' ? 'on' : '') + '">Fit Height</button>' +
      '</div>' +
      '<span class="rd-tb-sep"></span>' +
      '<div class="rd-tb-group" role="group" aria-label="Zoom">' +
      '<button type="button" data-rd-zoom="-15" aria-label="Zoom out">−</button>' +
      '<span class="rd-zoom-lbl" id="rdZoomLbl">' + state.zoom + '%</span>' +
      '<button type="button" data-rd-zoom="15" aria-label="Zoom in">+</button>' +
      '</div>' +
      '<span class="rd-page-scrub hidden" id="rdScrubWrap">' +
      '<button type="button" id="rdPgPrev" aria-label="Previous page">‹</button>' +
      '<input type="range" id="rdPgRange" min="1" max="1" value="1" aria-label="Page slider">' +
      '<button type="button" id="rdPgNext" aria-label="Next page">›</button>' +
      '</span>' +
      '</div>' +
      '<div class="rd-drawer-bg" id="rdDrawerBg"></div>' +
      '<aside class="rd-drawer" id="rdChapDrawer" aria-label="Chapter drawer">' +
      '<div class="rd-drawer-head"><b>Chapters</b><button type="button" id="rdDrawerClose" aria-label="Close drawer">×</button></div>' +
      '<input type="search" class="rd-drawer-search" id="rdDrawerSearch" placeholder="Jump to chapter…" autocomplete="off" />' +
      '<div class="rd-drawer-list" id="rdDrawerList"></div>' +
      '</aside>' +
      '<div class="rd-rprog"><i id="rdRProg"></i></div>';
    document.body.appendChild(readerEl);
    document.body.classList.add('rd-lock');

    $('#rdRBack', readerEl).onclick = closeReader;
    if (prev) $('#rdRPrev', readerEl).onclick = prev.run;
    if (next) $('#rdRNext', readerEl).onclick = next.run;
    $('#rdDrawerBtn', readerEl).onclick = function () { setChapterDrawer(!readerSession.drawerOpen); };
    $('#rdDrawerClose', readerEl).onclick = function () { setChapterDrawer(false); };
    $('#rdDrawerBg', readerEl).onclick = function () { setChapterDrawer(false); };
    $('#rdDrawerSearch', readerEl).oninput = function () { renderDrawerChapters(this.value); };

    $$('[data-rd-mode]', readerEl).forEach(function (b) {
      b.onclick = function () {
        state.readerMode = b.getAttribute('data-rd-mode') || 'webtoon';
        savePrefs();
        syncReaderToolbar();
        renderReaderPages();
        try { window.dispatchEvent(new CustomEvent('sb:reader-mode', { detail: { mode: state.readerMode, fit: state.fitMode, zoom: state.zoom } })); } catch (e) {}
      };
    });
    $$('[data-rd-fit]', readerEl).forEach(function (b) {
      b.onclick = function () {
        state.fitMode = b.getAttribute('data-rd-fit') || 'width';
        savePrefs();
        syncReaderToolbar();
        renderReaderPages();
      };
    });
    $$('[data-rd-zoom]', readerEl).forEach(function (b) {
      b.onclick = function () {
        var delta = parseInt(b.getAttribute('data-rd-zoom'), 10) || 0;
        state.zoom = Math.max(60, Math.min(180, (state.zoom || 100) + delta));
        syncReaderToolbar();
        applyReaderZoom();
      };
    });
    $('#rdPgPrev', readerEl).onclick = function () { stepReaderPage(-1); };
    $('#rdPgNext', readerEl).onclick = function () { stepReaderPage(1); };
    $('#rdPgRange', readerEl).oninput = function () {
      var v = Math.max(0, (parseInt(this.value, 10) || 1) - 1);
      readerSession.pageIdx = v;
      renderReaderPages();
    };

    var body = $('#rdRBody', readerEl);
    body.addEventListener('click', function (ev) {
      if (ev.target.closest('button, input, a')) return;
      toggleReaderHud();
    });
    readerEl.addEventListener('mousemove', function (ev) {
      if (ev.clientY < 86 || ev.clientY > window.innerHeight - 104) showReaderHud(false);
    });
    [$('#rdRTop', readerEl), $('#rdToolbar', readerEl)].forEach(function (bar) {
      if (!bar) return;
      bar.addEventListener('mouseenter', function () { showReaderHud(true); });
      bar.addEventListener('mouseleave', function () { showReaderHud(false); });
    });

    readerKeyHandler = function (ev) {
      if (!readerEl) return;
      if (ev.key === 'ArrowRight' && state.readerMode !== 'webtoon') { ev.preventDefault(); stepReaderPage(1); }
      else if (ev.key === 'ArrowLeft' && state.readerMode !== 'webtoon') { ev.preventDefault(); stepReaderPage(-1); }
      else if (ev.key === 'c' || ev.key === 'C') { setChapterDrawer(!readerSession.drawerOpen); }
    };
    document.addEventListener('keydown', readerKeyHandler);
    showReaderHud(false);
    return readerEl;
  }

  function syncReaderToolbar() {
    if (!readerEl) return;
    readerEl.setAttribute('data-reader-mode', state.readerMode);
    $$('[data-rd-mode]', readerEl).forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-rd-mode') === state.readerMode);
    });
    $$('[data-rd-fit]', readerEl).forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-rd-fit') === state.fitMode);
    });
    var zl = $('#rdZoomLbl', readerEl);
    if (zl) zl.textContent = (state.zoom || 100) + '%';
    var scrub = $('#rdScrubWrap', readerEl);
    if (scrub) scrub.classList.toggle('hidden', state.readerMode === 'webtoon' || !readerSession.urls.length);
  }
  function applyReaderZoom() {
    if (!readerEl) return;
    var z = (state.zoom || 100) / 100;
    var strip = $('.rd-strip', readerEl);
    if (strip) strip.style.maxWidth = Math.round(820 * z) + 'px';
    var frame = $('.rd-page-frame', readerEl);
    if (frame) frame.style.transform = z === 1 ? '' : ('scale(' + z.toFixed(2) + ')');
  }
  function stepReaderPage(delta) {
    var urls = readerSession.urls || [];
    if (!urls.length) return;
    if (state.readerMode === 'spread') {
      var pairs = buildSpreadPairs(urls.length);
      var nextIdx = readerSession.pageIdx + delta;
      if (nextIdx < 0) { if (readerSession.prev) readerSession.prev.run(); return; }
      if (nextIdx >= pairs.length) { if (readerSession.next) readerSession.next.run(); else toast('End of chapter'); return; }
      readerSession.pageIdx = nextIdx;
    } else {
      var nxt = readerSession.pageIdx + delta;
      if (nxt < 0) { if (readerSession.prev) readerSession.prev.run(); return; }
      if (nxt >= urls.length) { if (readerSession.next) readerSession.next.run(); else toast('End of chapter'); return; }
      readerSession.pageIdx = nxt;
    }
    renderReaderPages();
  }
  function renderReaderPages() {
    if (!readerEl) return;
    var body = $('#rdRBody', readerEl);
    var urls = readerSession.urls || [];
    var ref = readerSession.ref || '';
    if (!body || !urls.length) return;
    syncReaderToolbar();
    var pagesEl = $('#rdRPages', readerEl);
    var progBar = $('#rdRProg', readerEl);

    if (state.readerMode === 'webtoon') {
      body.innerHTML = '<div class="rd-strip fit-' + state.fitMode + '">' + urls.map(function (u, i) {
        return '<img loading="' + (i < 3 ? 'eager' : 'lazy') + '" decoding="async" src="' + esc(img(u, ref)) +
          '" alt="Page ' + (i + 1) + '" data-pg="' + (i + 1) + '" class="rd-on" onerror="this.classList.add(\'rd-fail\');this.alt=\'Page ' + (i + 1) + ' failed to load\'">';
      }).join('') + '</div><div class="rd-rend" id="rdREnd">' +
        '<div>End of chapter</div>' +
        (readerSession.prev ? '<button class="rd-btn" type="button" id="rdEndPrev">‹ Previous</button>' : '') +
        (readerSession.next ? '<button class="rd-btn gold" type="button" id="rdEndNext">Next Chapter ›</button>' : '') +
        '</div>';
      if ($('#rdEndPrev', body) && readerSession.prev) $('#rdEndPrev', body).onclick = readerSession.prev.run;
      if ($('#rdEndNext', body) && readerSession.next) $('#rdEndNext', body).onclick = readerSession.next.run;
      if (pagesEl) pagesEl.textContent = urls.length + ' pages';
      applyReaderZoom();
      bindReaderScroll(readerKey);
      return;
    }

    body.onscroll = null;
    body.scrollTop = 0;
    var isSpread = state.readerMode === 'spread';
    var pairs = isSpread ? buildSpreadPairs(urls.length) : urls.map(function (_, i) { return [i]; });
    if (readerSession.pageIdx >= pairs.length) readerSession.pageIdx = pairs.length - 1;
    if (readerSession.pageIdx < 0) readerSession.pageIdx = 0;
    var slice = pairs[readerSession.pageIdx] || [0];
    var pgLabel = slice.length === 2
      ? ('Pages ' + (slice[0] + 1) + '–' + (slice[1] + 1) + ' / ' + urls.length)
      : ('Page ' + (slice[0] + 1) + ' / ' + urls.length);
    if (pagesEl) pagesEl.textContent = pgLabel;
    if (progBar) progBar.style.width = (((readerSession.pageIdx + 1) / Math.max(1, pairs.length)) * 100).toFixed(1) + '%';
    var rng = $('#rdPgRange', readerEl);
    if (rng) { rng.max = String(pairs.length); rng.value = String(readerSession.pageIdx + 1); }

    body.innerHTML =
      '<div class="rd-paged-stage mode-' + state.readerMode + ' fit-' + state.fitMode + '">' +
      '<button type="button" class="rd-nav-zone prev" aria-label="Previous page"></button>' +
      '<div class="rd-page-frame">' +
      slice.map(function (idx) {
        return '<img class="rd-on" decoding="async" src="' + esc(img(urls[idx], ref)) + '" alt="Page ' + (idx + 1) + '" onerror="this.classList.add(\'rd-fail\')">';
      }).join('') +
      '</div>' +
      '<button type="button" class="rd-nav-zone next" aria-label="Next page"></button>' +
      '</div>';
    var zPrev = $('.rd-nav-zone.prev', body);
    var zNext = $('.rd-nav-zone.next', body);
    if (zPrev) zPrev.onclick = function (e) { e.stopPropagation(); stepReaderPage(-1); };
    if (zNext) zNext.onclick = function (e) { e.stopPropagation(); stepReaderPage(1); };
    applyReaderZoom();
    // Prefetch next spread/page
    var nextSlice = pairs[readerSession.pageIdx + 1] || [];
    nextSlice.forEach(function (ni) { try { new Image().src = img(urls[ni], ref); } catch (e) {} });
  }

  function closeReader() {
    if (!readerEl) return false;
    clearTimeout(readerSession.hudTimer);
    if (readerKeyHandler) { document.removeEventListener('keydown', readerKeyHandler); readerKeyHandler = null; }
    try { readerEl.remove(); } catch (e) {}
    readerEl = null;
    document.body.classList.remove('rd-lock');
    if (state.view === 'detail') paint();
    return true;
  }
  function bindReaderScroll(key) {
    var body = $('#rdRBody', readerEl);
    var bar = $('#rdRProg', readerEl);
    if (!body) return;
    var saved = lsGet(readPosKey(state.detail && state.detail.source, key), null);
    var ticking = false;
    body.onscroll = function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        ticking = false;
        var max = Math.max(1, body.scrollHeight - body.clientHeight);
        if (bar) bar.style.width = Math.min(100, (body.scrollTop / max) * 100) + '%';
        clearTimeout(scrollSaveTimer);
        scrollSaveTimer = setTimeout(function () {
          lsSet(readPosKey(state.detail && state.detail.source, key), { y: body.scrollTop, at: Date.now() });
        }, 500);
      });
    };
    if (saved && saved.y > 30) {
      [220, 900, 1900].forEach(function (delay) {
        setTimeout(function () {
          if (body.scrollTop < 30) { try { body.scrollTop = saved.y; } catch (e) {} }
        }, delay);
      });
    }
  }
  function readerImages(urls, ref) {
    readerSession.urls = Array.isArray(urls) ? urls : [];
    readerSession.ref = ref || '';
    readerSession.pageIdx = 0;
    for (var i = 0; i < Math.min(readerSession.urls.length, 4); i++) {
      try { new Image().src = img(readerSession.urls[i], ref); } catch (e) {}
    }
    renderReaderPages();
  }

  var readerKey = '';

  async function openMdChapter(manga, chapter) {
    state.detail = manga;
    manga.chapters = manga.chapters || [];
    var idx = manga.chapters.findIndex(function (c) { return c.id === chapter.id; });
    var label = chapter.chapter ? 'Chapter ' + chapter.chapter : 'Oneshot';
    var prev = readerNav(manga, idx);
    var next = readerNext(manga, idx);
    readerKey = chapter.id;
    readerShell(manga.title, label + (chapter.title ? ' · ' + chapter.title : ''), prev, next, '');
    saveProgress({
      source: 'md', id: manga.id, title: manga.title, cover: manga.cover, desc: manga.desc,
      tags: manga.tags, year: manga.year, status: manga.status, author: manga.author,
      chapterId: chapter.id, chapterLabel: label, page: 0
    });
    try {
      var j = await api('https://api.mangadex.org/at-home/server/' + chapter.id, 30000);
      var host = j.baseUrl || '';
      var hash = (j.chapter && j.chapter.hash) || '';
      var files = (j.chapter && (j.chapter.data || j.chapter.dataSaver)) || [];
      if (!host || !hash || !files.length) throw new Error('Chapter pages unavailable');
      var urls = files.map(function (f) { return host + '/data/' + hash + '/' + f; });
      readerImages(urls, 'https://mangadex.org/');
    } catch (e) {
      var body = readerEl && $('#rdRBody', readerEl);
      if (body) body.innerHTML = '<div class="rd-empty" style="margin:60px auto;max-width:520px">This chapter could not be loaded.<br><br>' +
        '<button class="rd-btn gold" type="button" id="rdRClose">Back to chapters</button></div>';
      var b = readerEl && $('#rdRClose', readerEl);
      if (b) b.onclick = function () { closeReader(); };
    }
  }

  async function openWtChapter(series, ep) {
    state.detail = series;
    series.episodes = series.episodes || [];
    if (!ep.url) ep.url = wtSeriesUrlFrom(series.url, ep.no);
    var idx = series.episodes.findIndex(function (x) { return Number(x.no) === Number(ep.no); });
    /* Episode numbers are the navigation key, not list position: page one of
       a series only lists the newest ten episodes, yet Prev/Next must still
       walk through older numbers. */
    var prev = ep.no > 1 ? {
      label: '‹ Prev',
      run: function () {
        openWtChapter(series, series.episodes.filter(function (x) { return Number(x.no) === Number(ep.no) - 1; })[0] ||
          { no: Number(ep.no) - 1, title: 'Episode ' + (Number(ep.no) - 1), url: wtSeriesUrlFrom(series.url, Number(ep.no) - 1) });
      }
    } : null;
    var next = {
      label: 'Next ›',
      run: function () {
        var nxt = idx > 0 ? series.episodes[idx - 1] : null;
        if (!nxt || Number(nxt.no) !== Number(ep.no) + 1) {
          nxt = { no: Number(ep.no) + 1, title: 'Episode ' + (Number(ep.no) + 1), url: wtSeriesUrlFrom(series.url, Number(ep.no) + 1) };
        }
        openWtChapter(series, nxt);
      }
    };
    readerKey = 'ep' + ep.no;
    readerShell(series.title, 'Episode ' + ep.no + (ep.title && ep.title !== ('Episode ' + ep.no) ? ' · ' + ep.title : ''), prev, next, '');
    saveProgress({
      source: 'wt', id: series.id, title: series.title, cover: series.cover, desc: series.desc,
      seriesUrl: series.url, ep: ep.no, chapterLabel: 'Episode ' + ep.no
    });
    try {
      var html = await page(ep.url, 30000);
      var doc = new DOMParser().parseFromString(html, 'text/html');
      var urls = $$('#_imageList img[data-url], .viewer_img img[data-url], img[data-url]', doc)
        .map(function (im) { return im.getAttribute('data-url'); })
        .filter(Boolean);
      if (!urls.length) throw new Error('Viewer images unavailable');
      readerImages(urls, 'https://www.webtoons.com/');
    } catch (e) {
      var body = readerEl && $('#rdRBody', readerEl);
      if (body) body.innerHTML = '<div class="rd-empty" style="margin:60px auto;max-width:520px">This episode could not be loaded.<br><br>' +
        '<button class="rd-btn gold" type="button" id="rdRClose">Back to episodes</button></div>';
      var b = readerEl && $('#rdRClose', readerEl);
      if (b) b.onclick = function () { closeReader(); };
    }
  }

  /* ------------------------------------------------------------- opening */
  async function openDetail(item) {
    state.view = 'detail';
    state.detail = item;
    paint();
    if (item.source === 'md') {
      // Refresh metadata + first feed page; browsing data may be stale.
      try {
        var j = await api('https://api.mangadex.org/manga/' + item.id + '?includes[]=cover_art&includes[]=author');
        if (j && j.data) {
          var fresh = mdCard(j.data);
          fresh.chapters = item.chapters;
          state.detail = fresh;
          if (state.view === 'detail') paint();
        }
      } catch (e) {}
      try {
        await mdFeed(state.detail, 0, false);
        if (state.view === 'detail') paint();
      } catch (e) {
        if (state.view === 'detail') paint();
      }
    } else if (item.source === 'wt') {
      try {
        var s = await wtSeries(item.url);
        s.id = item.id || s.id;
        state.detail = s;
        if (state.view === 'detail') paint();
      } catch (e) {}
    } else if (isNativeSource(item.source)) {
      try {
        var nd = await nativeDetail(item);
        nd.id = item.id || nd.id;
        state.detail = nd;
        if (state.view === 'detail') paint();
      } catch (e) {
        if (state.view === 'detail') {
          state.detail.chapters = [];
          state.detail.loadError = true;
          paint();
          toast(sourceName(item.source) + ' could not load this title');
        }
      }
    }
  }

  function paint() {
    if (!root) return;
    style();
    root.innerHTML = shellHtml();
    paintChips();
    bind();
    paintBody();
  }

  function bind() {
    if (!root) return;
    function reload() { reloadSource(); }
    function resetFilters() {
      state.q = '';
      state.genre = '';
      state.type = '';
      state.lang = 'en';
      savePrefs();
      paint();
      reload();
    }
    $$('[data-rd-source]', root).forEach(function (b) {
      b.onclick = function () {
        var s = b.getAttribute('data-rd-source');
        if (!s || s === state.source) return;
        state.source = s;
        state.items = [];
        state.offset = 0;
        state.page = 1;
        state.genre = '';
        state.q = '';
        var np = providerById(s);
        state.tab = np && np.tabs ? np.tabs[0].c : '';
        state.type = typeForSource(state.type);
        if (state.adultMode) lsSet('sb.read.adult.src', s);
        savePrefs();
        paint();
        reload();
      };
    });
    $$('[data-rd-tab]', root).forEach(function (b) {
      b.onclick = function () {
        var t = b.getAttribute('data-rd-tab');
        if (!t || t === state.tab) return;
        state.tab = t;
        state.items = [];
        state.page = 1;
        state.genre = '';
        state.q = '';
        var inp = $('#rdSearch', root);
        if (inp) inp.value = '';
        paint();
        reload();
      };
    });
    var sourceSel = $('#rdSourceSel', root);
    if (sourceSel) sourceSel.onchange = function () {
      var s = sourceSel.value;
      if (!s || s === state.source) return;
      if (!providerById(s)) return;
      state.source = s;
      state.items = [];
      state.offset = 0;
      state.genre = '';
      state.q = '';
      state.type = '';
      savePrefs();
      paint();
      reload();
    };
    var form = $('#rdForm', root);
    if (form) form.onsubmit = function (e) {
      e.preventDefault();
      state.q = String($('#rdSearch', root).value || '').trim();
      state.genre = '';
      savePrefs();
      paintChips();
      reload();
    };
    var input = $('#rdSearch', root);
    if (input) input.oninput = function () {
      clearTimeout(searchTimer);
      var v = input.value.trim();
      if (!v) return;
      searchTimer = setTimeout(function () {
        state.q = v;
        state.genre = '';
        savePrefs();
        paintChips();
        reload();
      }, 520);
    };
    var langSel = $('#rdLang', root);
    if (langSel) langSel.onchange = function () {
      state.lang = langSel.value || 'en';
      state.items = [];
      state.offset = 0;
      savePrefs();
      paint();
      reload();
    };
    var typeSel = $('#rdType', root);
    if (typeSel) typeSel.onchange = function () {
      state.type = typeForSource(typeSel.value);
      state.items = [];
      state.offset = 0;
      savePrefs();
      paint();
      reload();
    };
    var reset = $('#rdReset', root);
    if (reset) reset.onclick = resetFilters;
    $$('[data-rd-rating]', root).forEach(function (b) {
      b.onclick = function () {
        var r = b.getAttribute('data-rd-rating');
        if (r !== 'safe' && r !== 'teen') return;
        if (r === state.rating) return;
        state.rating = r;
        state.items = [];
        state.offset = 0;
        paint();
        reload();
      };
    });
    root.onclick = function (e) {
      if (e.target.closest('[data-rd-reset]')) { resetFilters(); return; }
      var chip = e.target.closest('[data-rd-genre]');
      if (chip) {
        state.genre = chip.getAttribute('data-rd-genre') || '';
        state.q = '';
        savePrefs();
        paintChips();
        var inp = $('#rdSearch', root);
        if (inp) inp.value = '';
        reload();
        return;
      }
      var open = e.target.closest('[data-rd-open]');
      if (open) {
        var parts = String(open.getAttribute('data-rd-open')).split(':');
        var key = parts[0] + ':' + parts.slice(1).join(':');
        var item = state.items.filter(function (x) { return x.source + ':' + x.id === key; })[0];
        if (item) openDetail(item);
        return;
      }
      var hist = e.target.closest('[data-rd-hist]');
      if (hist) { openFromHistory(hist.getAttribute('data-rd-hist')); return; }
    };
  }

  /* ---------------------------------------------------------------- public */
  async function testProvider(source, query) {
    var p = providerById(source);
    if (!p) return { source: source, ok: false, error: 'unknown provider' };
    var out = { source: source, name: p.name };
    try {
      var list;
      if (p.catalog) {
        var got0 = await p.catalog(query || 'solo leveling');
        list = (got0 && got0.items) || got0 || [];
      } else {
        list = parseNativeCatalog(await nativeSnapshot(p, query && p.search ? p.search(query) : p.home, 'catalog'), p);
      }
      list = (list || []).filter(function (x) { return x && x.url; });
      out.catalog = list.length;
      out.sample = list[0] ? { title: list[0].title, cover: !!list[0].cover, url: list[0].url } : null;
      if (!list.length) throw new Error('empty catalog');
      var item = list[0];
      var detail = await nativeDetail(item);
      out.title = detail.title;
      out.coverOk = !!detail.cover;
      out.chapters = (detail.chapters || []).length;
      if (!out.chapters) throw new Error('no chapters');
      var chs = detail.chapters || [];
      var ch = chs[Math.min(2, chs.length - 1)];
      out.chapter = ch.title;
      var urls = null;
      if (p.chapter) {
        try { urls = await p.chapter(detail, ch); }
        catch (e1) { out.hookError = String((e1 && e1.message) || e1); }
      }
      if (!urls || !urls.length) {
        urls = parseNativeChapter(await nativeSnapshot(p, ch.url, 'chapter'), p, ch.url);
      }
      out.pages = (urls || []).length;
      out.pageSample = (urls || [])[0] || '';
      out.ok = out.catalog > 0 && out.chapters > 0 && out.pages > 0;
    } catch (e) {
      out.ok = false;
      out.error = String((e && e.message) || e);
    }
    return out;
  }

  var VERIFY = false;
  try { VERIFY = /(^|[?&])sbverify=1(&|$)/.test(location.search) || localStorage.getItem('sb:verify') === '1'; } catch (e) {}
  var publicApi = {
    render: function (host, opts) {
      root = host || root;
      var wantAdult = !!(opts && opts.adult);
      var modeChanged = wantAdult !== state.adultMode;
      state.adultMode = wantAdult;
      if (modeChanged) { state.q = ''; state.genre = ''; }
      if (wantAdult) {
        state.source = (opts && (opts.source === 'nhentai' || opts.source === 'hentai20'))
          ? opts.source : (lsGet('sb.read.adult.src', 'hentai20') || 'hentai20');
        if (!providerById(state.source)) state.source = 'hentai20';
        if (opts && opts.query) state.q = opts.query;
        state.lang = 'en';
        state.rating = 'mature';
        state.page = 1;
        var np = providerById(state.source);
        state.tab = np && np.tabs && np.tabs.length ? np.tabs[0].c : '';
      } else {
        if (isAdultSourceId(state.source)) state.source = 'md';
        if (state.rating === 'mature') state.rating = 'safe';
      }
      state.view = 'browse';
      state.detail = null;
      state.items = [];
      style();
      base().then(function () {
        if (!root) return;
        paint();
        mdTags().then(function () {
          if (root && !state.adultMode && state.source === 'md' && state.view === 'browse') paintChips();
        });
        reloadSource();
      });
    },
    renderAdult: function (host, opts) {
      opts = opts || {};
      publicApi.render(host, { adult: true, source: opts.source, query: opts.query });
    },
    registerAdultAdapter: function (id, adapter) {
      if (id && adapter) adultAdapters[id] = adapter;
    },
    openChapterPages: function (title, sub, urls, ref, prev, next) {
      readerKey = 'custom:' + Date.now();
      readerShell(title || 'Reader', sub || '', prev || null, next || null, (urls || []).length + ' pages');
      readerImages(urls || [], ref || '');
    },
    close: function () {
      if (readerEl) { closeReader(); return; }
      state.view = 'browse';
      state.detail = null;
    },
    back: function () {
      if (readerEl) return closeReader();
      if (state.view === 'detail') {
        state.view = 'browse';
        state.detail = null;
        paint();
        return true;
      }
      return false;
    },
    open: openDetail,
    source: function () { return state.source; },
    buildSpreadPairs: buildSpreadPairs,
    version: '1.4.0'
  };
  if (VERIFY) {
    publicApi.probe = {
      readNet: readNet, readNetJSON: readNetJSON, renderSnap: renderSnap, page: page,
      nativeSnapshot: nativeSnapshot, parseNativeCatalog: parseNativeCatalog, tsApi: tsApi,
      mdFeed: mdFeed
    };
    publicApi.testProvider = testProvider;
  }
  window.READER = publicApi;
})();
