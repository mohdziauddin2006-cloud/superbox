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
  var state = {
    source: 'md',
    q: '',
    lang: LANGUAGES.some(function (l) { return l.c === savedLang; }) ? savedLang : 'en',
    type: typeof savedType === 'string' ? savedType : '',
    genre: typeof savedGenre === 'string' ? savedGenre : '',
    rating: 'teen',
    offset: 0,
    items: [],
    total: 0,
    loading: false,
    more: false,
    req: 0,
    ctl: null,
    view: 'browse',
    detail: null,
    wtPage: 1
  };
  function savePrefs() {
    lsSet('sb.read.lang', state.lang || 'en');
    lsSet('sb.read.type', state.type || '');
    lsSet('sb.read.genre', state.genre || '');
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
    if (state.source === 'md') mdLoad(false);
    else if (state.source === 'wt') wtLoad();
    else nativeLoad(false);
  }

  var WT_GENRES = [
    { s: 'action', n: 'Action' }, { s: 'romance', n: 'Romance' }, { s: 'fantasy', n: 'Fantasy' },
    { s: 'comedy', n: 'Comedy' }, { s: 'drama', n: 'Drama' }, { s: 'thriller', n: 'Thriller' },
    { s: 'slice-of-life', n: 'Slice of Life' }, { s: 'sports', n: 'Sports' }, { s: 'sci-fi', n: 'Sci-Fi' },
    { s: 'mystery', n: 'Mystery' }, { s: 'historical', n: 'Historical' },
    { s: 'heartwarming', n: 'Heartwarming' }, { s: 'horror', n: 'Horror' },
    { s: 'supernatural', n: 'Supernatural' }, { s: 'school', n: 'School' }
  ];

  function ratingAllowed(item) {
    if (state.rating === 'mature') return true;
    if (item.rating === 'erotica' || item.rating === 'pornographic') return false;
    if (item.adult) return state.rating === 'mature';
    return true;
  }
  function ratingPairs() {
    if (state.rating === 'safe') return ['safe'];
    if (state.rating === 'mature') return ['erotica', 'pornographic'];
    return ['safe', 'suggestive'];
  }
  function qs(pairs) {
    return pairs.map(function (p) { return p[0] + '=' + enc(p[1]); }).join('&');
  }

  /* -------------------------------------------------------------- history */
  function history() {
    var list = lsGet('sb.read.history', []);
    return Array.isArray(list) ? list : [];
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
      home: 'https://vortexscans.org/series',
      search: function (q) { return 'https://vortexscans.org/series/?searchTerm=' + enc(q); },
      seriesRe: /\/series\/[^/?#]+\/?$/i,
      chapterRe: /\/series\/[^/?#]+\/chapter-[\d.]+/i,
      imgRe: /storage\.vortexscans\.org\/upload\/series\/.+\/page-/i
    },
    {
      id: 'hive', name: 'HiveToons', short: 'HIVE', ref: 'https://hivetoons.org/',
      home: 'https://hivetoons.org/series',
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
    },
    {
      id: 'hentai20', name: 'Hentai20', short: 'H20', ref: 'https://hentai20.io/',
      home: 'https://hentai20.io/home1/',
      search: function (q) { return 'https://hentai20.io/?s=' + enc(q); },
      seriesRe: /\/manga\/[^/?#]+\/?$/i,
      chapterRe: /\/[^/?#]+-chapter-[\d.]+\/?$/i,
      imgRe: /img\.hentai1\.io\/.+\/chapter-/i,
      adult: true
    }
  ];
  function providerById(id) {
    return NATIVE_PROVIDERS.filter(function (p) { return p.id === id; })[0] || null;
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
      url: url, title: text(doc.querySelector('title')),
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
      .replace(/^\d+\s+/, '')
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
    return /logo|favicon|avatar|icon|banner|thumbnail|thumb|cover|profile|emoji|placeholder|spacer|loading|transparent|read_on_|discord|patreon|ko-fi|kofi|twitter|facebook|reddit|ads?\.|doubleclick|analytics|pixel|1x1|blank\./i.test(String(u || ''));
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
      var no = chapterNoOf(label, u);
      var keyNo = (no < 1e9 ? String(no) : u) + '|' + label.replace(/\s+\d+\s+(?:hour|day|week|month|year)s?\s+ago.*$/i, '').trim();
      if (seenNo[keyNo]) return;
      seenNo[keyNo] = 1;
      seen[u] = 1;
      d.chapters.push({
        id: u, url: u, title: chapterLabelOf(label, 'Chapter'),
        no: no, lang: 'en'
      });
    });
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
      var label = String(a.a || a.t || '');
      var no = null;
      var em = /(?:ep|episode|chapter)\s*\.?\s*(\d+(?:\.\d+)?)/i.exec(label);
      if (em) no = parseFloat(em[1]);
      if (no == null) no = chapters.length + 1;
      chapters.push({
        id: m[1], no: no, title: 'Episode ' + no,
        url: 'https://tapas.io/episode/' + m[1], lang: 'en'
      });
    });
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
    function add(u) {
      u = String(u || '').replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/&amp;/g, '&');
      if (!/^https?:\/\/[^"'\s]+$/i.test(u)) return;
      if (!/tapas\.io\/|\.(?:jpe?g|png|webp|gif)(?:\?|$)/i.test(u)) return;
      if (/logo|avatar|icon|cover|thumb|emoji/i.test(u)) return;
      if (seen[u]) return;
      seen[u] = 1; urls.push(u);
    }
    (snap.readers || []).forEach(function (r) { add(r.s || r); });
    (snap.images || []).forEach(function (im) { if ((im.w || 0) >= 480) add(im.s); });
    var s = String(snap.html || '').replace(/\\\//g, '/').replace(/\\u0026/gi, '&');
    var re = /https:\/\/us-a\.tapas\.io\/pc\/[^"'\s<>\\]+/gi, m;
    while ((m = re.exec(s))) add(m[0].replace(/[),.;]+$/, ''));
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
    if (!append) { state.items = []; state.offset = 0; }
    paintBody();
    try {
      var list = null;
      if (p.catalog) {
        try { list = await p.catalog(state.q); }
        catch (e) { list = null; }
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
      state.items = list;
      state.total = list.length;
      state.more = false;
    } catch (e) {
      if (req !== state.req) return;
      state.items = [];
      state.total = 0;
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
      '.rd-shell{max-width:1500px;margin:0 auto;padding:24px 28px 90px}',
      '.rd-hero{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap;margin:0 0 20px}',
      '.rd-hero h1{font-size:clamp(30px,4.4vw,52px);line-height:.95;letter-spacing:-.045em;margin:0 0 10px}',
      '.rd-hero h1 em{font-style:normal;color:#ffc105}',
      '.rd-hero p{color:#989eaa;margin:0;max-width:640px;font-size:14px;line-height:1.55}',
      '.rd-hero .rd-stat{display:flex;gap:9px;flex-wrap:wrap}',
      '.rd-stat span{border:1px solid #272b34;background:#121419;border-radius:999px;padding:8px 13px;font-size:11.5px;color:#aab0bb;letter-spacing:.04em}',
      '.rd-source{display:inline-flex;background:#111318;border:1px solid #23272f;border-radius:13px;padding:4px;gap:4px;margin:0 0 16px}',
      '.rd-source button{border:0;background:transparent;color:#9aa0aa;font-weight:700;font-size:13px;padding:10px 18px;border-radius:10px;cursor:pointer;transition:.16s}',
      '.rd-source button.on{background:#ffc105;color:#101010}',
      '.rd-source select{border:1px solid #2a2f39;background:#171a20;color:#e7e9ee;font-weight:700;font-size:12px;padding:9px 12px;border-radius:10px;cursor:pointer;outline:none;max-width:190px}',
      '.rd-source select option{background:#121419;color:#eceef2}',
      '.rd-tools{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:0 0 14px}',
      '.rd-filters{display:flex;gap:9px;flex-wrap:wrap;align-items:center;margin:0 0 15px}',
      '.rd-filters label{display:flex;align-items:center;gap:8px;background:#121419;border:1px solid #252a33;border-radius:12px;padding:7px 10px;font-size:11px;font-weight:700;color:#8f96a2;letter-spacing:.03em;text-transform:uppercase}',
      '.rd-filters select{background:transparent;border:0;color:#eceef2;font-size:12.5px;font-weight:600;outline:none;max-width:190px;cursor:pointer}',
      '.rd-filters select option{background:#121419;color:#eceef2}',
      '.rd-filters .rd-btn{padding:9px 12px;font-size:11.5px}',
      '.rd-fnote{color:#7e8490;font-size:11.5px;margin-left:auto}',
      '.rd-search{flex:1 1 320px;display:flex;gap:8px;min-width:240px}',
      '.rd-search input{flex:1;background:#121419;border:1px solid #252a33;color:#eceef2;border-radius:12px;padding:12px 15px;font-size:14px;outline:none;min-width:0}',
      '.rd-search input:focus{border-color:#ffc105;box-shadow:0 0 0 3px rgba(255,193,5,.12)}',
      '.rd-btn{border:1px solid #2a2f39;background:#171a20;color:#e7e9ee;border-radius:12px;padding:11px 16px;font-size:13px;font-weight:700;cursor:pointer;transition:.15s}',
      '.rd-btn:hover{border-color:#464d5b;background:#1d2129}',
      '.rd-btn.gold{background:#ffc105;border-color:#ffc105;color:#111}',
      '.rd-btn.ghost{background:transparent}',
      '.rd-rating{display:flex;gap:6px;flex-wrap:wrap}',
      '.rd-rating button{border:1px solid #252a33;background:#121419;color:#9399a4;border-radius:999px;padding:8px 13px;font-size:11.5px;font-weight:700;cursor:pointer}',
      '.rd-rating button.on{border-color:#ffc105;color:#ffc105;background:rgba(255,193,5,.08)}',
      '.rd-chips{display:flex;gap:7px;flex-wrap:wrap;margin:0 0 22px}',
      '.rd-chips button{border:1px solid #242832;background:#111318;color:#b9bec8;border-radius:999px;padding:8px 13px;font-size:12px;cursor:pointer;white-space:nowrap;transition:.14s}',
      '.rd-chips button:hover{border-color:#3b414d;color:#fff}',
      '.rd-chips button.on{background:#ffc105;border-color:#ffc105;color:#111;font-weight:800}',
      '.rd-sec{display:flex;align-items:center;justify-content:space-between;gap:14px;margin:0 0 13px}',
      '.rd-sec h2{font-size:17px;letter-spacing:-.01em;margin:0}',
      '.rd-sec .muted{color:#7e8490;font-size:12px}',
      '.rd-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(172px,1fr));gap:16px}',
      '.rd-card{text-align:left;border:0;background:transparent;color:inherit;cursor:pointer;padding:0;min-width:0}',
      '.rd-cover{position:relative;aspect-ratio:2/3;border-radius:13px;overflow:hidden;background:#14161b;border:1px solid #20242c;box-shadow:0 10px 26px rgba(0,0,0,.35)}',
      '.rd-cover img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .35s cubic-bezier(.2,.8,.2,1),opacity .3s}',
      '.rd-card:hover .rd-cover img{transform:scale(1.045)}',
      '.rd-card:hover .rd-cover{border-color:#3c424f}',
      '.rd-badge{position:absolute;left:8px;top:8px;background:rgba(8,9,11,.82);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.12);border-radius:7px;padding:4px 7px;font-size:9.5px;font-weight:800;letter-spacing:.08em;color:#ffd23f}',
      '.rd-badge.green{color:#41e88a;border-color:rgba(65,232,138,.3)}',
      '.rd-badge.native{color:#ffc105;border-color:rgba(255,193,5,.32)}',
      '.rd-card b{display:block;font-size:13.5px;line-height:1.32;margin:9px 0 3px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
      '.rd-card span{display:block;color:#7f8590;font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.rd-skel .rd-cover{animation:rdPulse 1.15s ease-in-out infinite alternate}',
      '@keyframes rdPulse{from{opacity:.55}to{opacity:1}}',
      '.rd-empty{color:#8b909a;padding:46px 6px;text-align:center;border:1px dashed #2a2f39;border-radius:16px}',
      '.rd-more{display:flex;justify-content:center;margin:28px 0 0}',
      '.rd-row{display:flex;gap:14px;overflow-x:auto;padding:2px 0 18px;scrollbar-width:thin}',
      '.rd-row .rd-item{flex:0 0 128px}',
      '.rd-row .rd-cover{aspect-ratio:2/3}',
      '.rd-row .rd-item b{font-size:12px}',
      '.rd-row .rd-item span{font-size:10.5px}',
      '.rd-item{text-align:left;border:0;background:transparent;color:inherit;cursor:pointer;padding:0;min-width:0}',
      '.rd-item .rd-cover{position:relative;border-radius:12px;overflow:hidden;background:#14161b;border:1px solid #20242c}',
      '.rd-item .rd-cover img{width:100%;height:100%;object-fit:cover;display:block}',
      '.rd-item b{display:block;font-size:13px;margin:8px 0 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.rd-item span{display:block;color:#7f8590;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.rd-detail{max-width:1180px;margin:0 auto;padding:8px 0 40px}',
      '.rd-back{border:1px solid #2a2f39;background:#15181e;color:#dfe2e8;border-radius:11px;padding:9px 14px;font-size:12.5px;font-weight:700;cursor:pointer;margin:0 0 20px}',
      '.rd-dhead{display:flex;gap:26px;align-items:flex-start;flex-wrap:wrap;margin:0 0 26px}',
      '.rd-dcover{flex:0 0 210px;max-width:210px;aspect-ratio:2/3;border-radius:16px;overflow:hidden;border:1px solid #232832;box-shadow:0 20px 50px rgba(0,0,0,.45);background:#14161b}',
      '.rd-dcover img{width:100%;height:100%;object-fit:cover;display:block}',
      '.rd-dinfo{flex:1 1 420px;min-width:260px}',
      '.rd-dinfo h1{font-size:clamp(26px,3.4vw,42px);letter-spacing:-.03em;line-height:1.04;margin:0 0 8px}',
      '.rd-dinfo .by{color:#a8aeb9;font-size:13px;margin:0 0 12px}',
      '.rd-dmeta{display:flex;gap:7px;flex-wrap:wrap;margin:0 0 16px}',
      '.rd-dmeta span{border:1px solid #272c35;background:#121419;color:#a9afb9;border-radius:999px;padding:6px 11px;font-size:11px}',
      '.rd-desc{color:#b4bac4;font-size:13.5px;line-height:1.65;margin:0 0 18px;max-width:760px;max-height:150px;overflow:auto}',
      '.rd-dactions{display:flex;gap:9px;flex-wrap:wrap;margin:0 0 22px}',
      '.rd-chapbar{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin:0 0 12px}',
      '.rd-chapbar h2{font-size:17px;margin:0}',
      '.rd-chapsearch{background:#121419;border:1px solid #252a33;color:#e8eaee;border-radius:10px;padding:9px 12px;font-size:12.5px;outline:none;min-width:180px}',
      '.rd-chaps{border:1px solid #22262e;border-radius:14px;overflow:hidden;background:#0f1115}',
      '.rd-chap{display:flex;align-items:center;gap:13px;width:100%;text-align:left;border:0;border-bottom:1px solid #1d2128;background:transparent;color:inherit;padding:12px 15px;cursor:pointer}',
      '.rd-chap:last-child{border-bottom:0}',
      '.rd-chap:hover{background:#151922}',
      '.rd-chap .n{flex:0 0 74px;color:#ffc105;font-weight:800;font-size:12.5px;letter-spacing:.03em}',
      '.rd-chap .t{flex:1;min-width:0;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.rd-chap .g{flex:0 0 150px;color:#777e8a;font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:right}',
      '.rd-chap .d{flex:0 0 92px;color:#666d78;font-size:11px;text-align:right}',
      '.rd-chap .done{color:#43d17c;font-size:11px;flex:0 0 auto}',
      '.rd-loading{padding:40px 0;text-align:center;color:#8b919c;font-size:13px}',
      '.rd-spin{display:inline-block;width:18px;height:18px;border:2px solid #2c313b;border-top-color:#ffc105;border-radius:50%;animation:rdSpin .8s linear infinite;vertical-align:-4px;margin-right:9px}',
      '@keyframes rdSpin{to{transform:rotate(360deg)}}',
      /* reader overlay */
      '.rd-reader{position:fixed;inset:0;z-index:120;background:#08090b;display:flex;flex-direction:column;animation:rdIn .22s ease both}',
      '@keyframes rdIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}',
      '.rd-rbar{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:calc(10px + env(safe-area-inset-top)) 14px 10px;background:rgba(10,11,14,.96);border-bottom:1px solid #1e222a;backdrop-filter:blur(16px);z-index:2}',
      '.rd-rbar button{border:1px solid #2a2f39;background:#15181e;color:#e8eaee;border-radius:10px;min-width:38px;height:38px;font-size:17px;line-height:1;cursor:pointer;padding:0 12px}',
      '.rd-rbar button:disabled{opacity:.32;cursor:default}',
      '.rd-rtitle{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.rd-rtitle b{font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.rd-rtitle span{font-size:11px;color:#858c98;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.rd-rpages{font-size:11.5px;color:#9aa1ad;white-space:nowrap}',
      '.rd-rbody{flex:1 1 auto;overflow-y:auto;-webkit-overflow-scrolling:touch;scroll-behavior:smooth;background:#050607}',
      '.rd-strip{max-width:820px;margin:0 auto;padding:0 0 26px;display:flex;flex-direction:column;align-items:center}',
      '.rd-strip img{display:block;width:100%;height:auto;background:#0d0f13;min-height:120px}',
      '.rd-strip img[data-src]{opacity:0}',
      '.rd-strip img.rd-on{opacity:1;transition:opacity .25s}',
      '.rd-strip img.rd-fail{min-height:220px;opacity:1}',
      '.rd-rend{max-width:820px;margin:0 auto;padding:30px 20px calc(70px + env(safe-area-inset-bottom));text-align:center;color:#8b929e;font-size:13px}',
      '.rd-rend button{margin:14px 6px 0}',
      '.rd-rprog{position:absolute;left:0;right:0;bottom:0;height:3px;background:#171a20}',
      '.rd-rprog i{display:block;height:100%;width:0%;background:linear-gradient(90deg,#ffc105,#ff8a00);transition:width .15s linear}',
      '.rd-toast{position:fixed;left:50%;bottom:28px;transform:translate(-50%,14px);z-index:200;background:#1a1e25;border:1px solid #333947;color:#f0f2f5;padding:11px 17px;border-radius:11px;font-size:12.5px;opacity:0;pointer-events:none;transition:.22s;max-width:88vw;text-align:center}',
      '.rd-toast.on{opacity:1;transform:translate(-50%,0)}',
      'body.rd-lock{overflow:hidden!important}',
      '@media(max-width:720px){.rd-shell{padding:14px 13px 92px}.rd-hero{gap:10px;margin-bottom:14px}.rd-hero p{font-size:12.5px}.rd-filters{gap:7px}.rd-filters label{flex:1 1 44%;min-width:0;padding:7px 9px}.rd-filters select{max-width:100%;width:100%}.rd-filters .rd-btn{flex:1 1 100%}.rd-fnote{display:none}.rd-grid{grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px}.rd-cover{border-radius:10px}.rd-card b{font-size:12px}.rd-card span{font-size:10.5px}.rd-source{width:100%}.rd-source button{flex:1;padding:9px 8px;font-size:12px}.rd-chips{margin-bottom:16px;flex-wrap:nowrap;overflow-x:auto;padding-bottom:4px}.rd-detail{padding:2px 0 20px}.rd-dcover{flex:0 0 128px;max-width:128px}.rd-dinfo h1{font-size:25px}.rd-desc{max-height:120px}.rd-chap .g{display:none}.rd-chap .d{flex-basis:70px}.rd-chap .n{flex-basis:62px}.rd-rpages{display:none}.rd-rtitle b{font-size:12.5px}.rd-rbar{gap:7px;padding-left:9px;padding-right:9px}.rd-rbar button{min-width:34px;height:34px;padding:0 9px;font-size:15px}}'
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
    var nativeOpts = NATIVE_PROVIDERS.map(function (p) {
      return '<option value="' + p.id + '"' + (state.source === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>';
    }).join('');
    var placeholder = state.source === 'md' ? 'Search manga, manhwa, titles...'
      : state.source === 'wt' ? 'Search WEBTOON series...'
        : 'Search ' + sourceName(state.source) + '...';
    var note = state.source === 'md'
      ? 'Showing titles with ' + esc(langLabel(state.lang)) + ' chapters'
      : state.source === 'wt'
        ? 'WEBTOON catalogue: ' + esc(WT_LOCALES[state.lang] ? langLabel(state.lang) : 'English')
        : esc(sourceName(state.source)) + ' · English chapters only · native reader';
    var langFilter = native
      ? '<label>Language<select id="rdLang" aria-label="Reading language" disabled><option>English</option></select></label>'
      : '<label>Language<select id="rdLang" aria-label="Reading language">' + optionHtml(LANGUAGES, state.lang) + '</select></label>';
    return '<div class="rd-shell">' +
      '<div class="rd-hero"><div><h1>Reading <em>room</em></h1>' +
      '<p>Manga, manhwa and webcomics from 15 native providers. Every catalogue, chapter and page is fetched by SuperBox itself through the Shield tunnel — nothing opens an external browser.</p></div>' +
      '<div class="rd-stat"><span>15 native sources</span><span>Strict language</span><span>VPN routed</span><span>Offline cache</span></div></div>' +
      '<div class="rd-source" role="tablist">' +
      '<button data-rd-source="md" role="tab" aria-selected="' + (state.source === 'md') + '" class="' + (state.source === 'md' ? 'on' : '') + '">MangaDex</button>' +
      '<button data-rd-source="wt" role="tab" aria-selected="' + (state.source === 'wt') + '" class="' + (state.source === 'wt' ? 'on' : '') + '">WEBTOON</button>' +
      '<select id="rdSourceSel" aria-label="All native reading sources"><option value="">More sources…</option>' + nativeOpts + '</select>' +
      '</div>' +
      '<div class="rd-tools"><form class="rd-search" id="rdForm">' +
      '<input id="rdSearch" type="search" autocomplete="off" placeholder="' + esc(placeholder) + '" value="' + esc(state.q) + '">' +
      '<button class="rd-btn gold" type="submit">Search</button></form>' +
      '<div class="rd-rating" role="group" aria-label="Age rating">' +
      '<button data-rd-rating="safe" class="' + (state.rating === 'safe' ? 'on' : '') + '">All ages</button>' +
      '<button data-rd-rating="teen" class="' + (state.rating === 'teen' ? 'on' : '') + '">Teen</button>' +
      '<button data-rd-rating="mature" class="' + (state.rating === 'mature' ? 'on' : '') + '">18+</button>' +
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
    var list = history().slice(0, 12);
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
  function readerShell(title, sub, prev, next, pages) {
    closeReader();
    style();
    readerEl = document.createElement('div');
    readerEl.className = 'rd-reader';
    readerEl.innerHTML = '<div class="rd-rbar">' +
      '<button type="button" id="rdRBack" aria-label="Back">←</button>' +
      '<div class="rd-rtitle"><b>' + esc(title) + '</b><span>' + esc(sub) + '</span></div>' +
      '<div class="rd-rpages" id="rdRPages">' + esc(pages || '') + '</div>' +
      '<button type="button" id="rdRPrev"' + (prev ? '' : ' disabled') + '>‹</button>' +
      '<button type="button" id="rdRNext"' + (next ? '' : ' disabled') + '>›</button>' +
      '</div><div class="rd-rbody" id="rdRBody"><div class="rd-loading" style="padding-top:80px"><span class="rd-spin"></span>Loading pages</div></div>' +
      '<div class="rd-rprog"><i id="rdRProg"></i></div>';
    document.body.appendChild(readerEl);
    document.body.classList.add('rd-lock');
    $('#rdRBack', readerEl).onclick = closeReader;
    if (prev) $('#rdRPrev', readerEl).onclick = prev.run;
    if (next) $('#rdRNext', readerEl).onclick = next.run;
    return readerEl;
  }
  function closeReader() {
    if (!readerEl) return false;
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
    var body = $('#rdRBody', readerEl);
    if (!body) return;
    body.innerHTML = '<div class="rd-strip">' + urls.map(function (u, i) {
      return '<img loading="' + (i < 2 ? 'eager' : 'lazy') + '" decoding="async" src="' + esc(img(u, ref)) +
        '" alt="Page ' + (i + 1) + '" data-pg="' + (i + 1) + '" onerror="this.classList.add(\'rd-fail\');this.alt=\'Page ' + (i + 1) + ' failed to load\'">';
    }).join('') + '</div><div class="rd-rend" id="rdREnd">' +
      '<div>End of chapter. Use the arrows above to continue.</div></div>';
    for (var i = 0; i < Math.min(urls.length, 4); i++) {
      try { new Image().src = img(urls[i], ref); } catch (e) {}
    }
    // Convert lazy placeholders to eager near-viewport loads as a fallback for
    // WebViews that ignore loading="lazy".
    var imgs = $$('img[data-pg]', body);
    imgs.forEach(function (im) { im.classList.add('rd-on'); });
    var pages = $('#rdRPages', readerEl);
    if (pages) pages.textContent = urls.length + ' pages';
    bindReaderScroll(readerKey);
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
        state.genre = '';
        state.q = '';
        state.type = typeForSource(state.type);
        savePrefs();
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
        if (r === state.rating) return;
        if (r === 'mature') {
          var ok = false;
          try { ok = window.confirm('Show 18+ manga and webcomics? This can include explicit adult content.'); } catch (e) {}
          if (!ok) return;
        }
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
  /* End-to-end probe used by the release verification harness. It runs the
     exact adapter paths the UI uses (catalog -> detail -> chapter images)
     without touching the visible view. */
  async function testProvider(source, query) {
    var p = providerById(source);
    if (!p) return { source: source, ok: false, error: 'unknown provider' };
    var out = { source: source, name: p.name };
    try {
      var list;
      if (p.catalog) list = await p.catalog(query || 'solo leveling');
      else list = parseNativeCatalog(await nativeSnapshot(p, query && p.search ? p.search(query) : p.home, 'catalog'), p);
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

  /* `?sbverify=1` keeps the adapter probes available to the offline release
     harness without publishing them in the normal UI. */
  var VERIFY = false;
  try { VERIFY = /(^|[?&])sbverify=1(&|$)/.test(location.search) || localStorage.getItem('sb:verify') === '1'; } catch (e) {}
  var publicApi = {
    render: function (host) {
      root = host || root;
      state.view = 'browse';
      state.detail = null;
      style();
      /* Resolve the bridge origin before painting so every cover uses the
         cached /img route instead of a raw origin URL. */
      base().then(function () {
        if (!root) return;
        paint();
        mdTags().then(function () {
          if (root && state.source === 'md' && state.view === 'browse') paintChips();
        });
        if (!state.items.length) reloadSource();
      });
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
    version: '1.3.0'
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
