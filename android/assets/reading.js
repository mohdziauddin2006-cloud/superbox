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
  async function page(url, ms, signal, ref) {
    var B = await base();
    var r = await withTimeout(fetch(B + '/page?url=' + enc(url) + (ref ? '&ref=' + enc(ref) : ''), { cache: 'no-store', signal: signal }), ms || 26000);
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
  function imgRef(url) {
    if (/mangadex|mangadex\.network|uploads\.mangadex/i.test(url)) return 'https://mangadex.org/';
    if (/pstatic\.net|webtoons\.com|naver/i.test(url)) return 'https://www.webtoons.com/';
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
  var savedReaderPrefs = lsGet('sb.read.viewer.prefs', null) || {};
  var readerPrefs = {
    mode: ['webtoon', 'single', 'spread'].indexOf(savedReaderPrefs.mode) >= 0 ? savedReaderPrefs.mode : 'webtoon',
    fit: savedReaderPrefs.fit === 'height' ? 'height' : 'width',
    zoom: Math.max(60, Math.min(200, Number(savedReaderPrefs.zoom) || 100))
  };
  function saveReaderPrefs() { lsSet('sb.read.viewer.prefs', readerPrefs); }
  var state = {
    adultMode: false,
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
    wtPage: 1,
    tab: '',
    page: 1
  };
  function savePrefs() {
    if (state.adultMode) return;
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
    return [{ c: '', n: 'All titles' }];
  }
  function typeForSource(code) {
    var allowed = state.source === 'md' ? ['', 'manga', 'manhwa', 'manhua', 'other']
      : state.source === 'wt' ? ['', 'originals', 'canvas'] : [''];
    return allowed.indexOf(code) >= 0 ? code : '';
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
    if (state.adultMode) return true;
    if (!item) return false;
    if (item.adult) return false;
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
  function historyKey() {
    return state.adultMode ? 'sb.read.adult.history' : 'sb.read.history';
  }
  function isAdultProviderId(source) {
    var p = providerById(source);
    return !!(p && p.adult);
  }
  function history() {
    var list = lsGet(historyKey(), []);
    if (!Array.isArray(list)) return [];
    if (!state.adultMode) {
      return list.filter(function (h) { return h && !h.adult && !isAdultProviderId(h.source); });
    }
    return list;
  }
  function remember(entry) {
    if (!entry || !entry.id) return;
    var adult = !!entry.adult || isAdultProviderId(entry.source);
    var key = adult ? 'sb.read.adult.history' : 'sb.read.history';
    var raw = lsGet(key, []);
    var list = (Array.isArray(raw) ? raw : []).filter(function (h) { return !(h.source === entry.source && h.id === entry.id); });
    list.unshift(entry);
    lsSet(key, list.slice(0, 16));
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
    /* Strict language contract: no cross-language fallback and no external
       official links. An empty feed means "no chapters in this language",
       which the detail page says plainly instead of quietly showing Japanese. */
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
     Every reading provider named in source.txt gets a native adapter. The
     catalogue, series metadata and chapter strip are fetched by SuperBox
     through /page or /reading/net and rendered by the in-app reader; no
     provider website is ever shown or linked. Sites that sign requests in
     page JavaScript (MangaFire, Tappytoon viewer) answer with a plain
     in-app explanation instead of opening an external browser. */
  async function readNetJSON(url, opts) {
    var B = await base();
    var r = await withTimeout(fetch(B + '/reading/net', {
      method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ url: url }, opts || {}))
    }), 30000);
    var raw = await withTimeout(r.text(), 30000);
    var j;
    try { j = JSON.parse(raw); } catch (e) { throw new Error('reading bridge returned no data'); }
    if (!j || !j.ok) throw new Error((j && j.error) || 'source unavailable');
    try { return JSON.parse(j.body); } catch (e) { throw new Error('bad response from source'); }
  }

  /* Raw body variant for Madara admin-ajax and other form POST endpoints. */
  async function readNetRaw(url, opts) {
    var B = await base();
    var r = await withTimeout(fetch(B + '/reading/net', {
      method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ url: url }, opts || {}))
    }), 30000);
    var raw = await withTimeout(r.text(), 30000);
    var j;
    try { j = JSON.parse(raw); } catch (e) { throw new Error('reading bridge returned no data'); }
    if (!j || !j.ok) throw new Error((j && j.error) || 'source unavailable');
    return String(j.body || '');
  }

  /* --------------------------------------------------------- 18+ reading
     Adult providers are a separate registry, mounted only by the age-gated
     18+ vault with READER.render(host, { adult: true }). General Reading
     never lists them, their titles or their covers. */
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
    var doc = h20Doc(await page(url, 30000, null, 'https://hentai20.io/'));
    if (!doc) throw new Error('Hentai20 returned no catalogue');
    var out = [], seen = {};
    $$('a[href*="/manga/"]', doc).forEach(function (a) {
      var u = absolute(a.getAttribute('href'), url).replace(/[?#].*$/, '');
      if (!/^https:\/\/hentai20\.io\/manga\/[^/?#]+\/?$/i.test(u)) return;
      if (seen[u]) return;
      var card = a.closest('.bs, .bsx, .utao, .listupd li') || a.parentElement;
      var im = a.querySelector('img') || (card && card.querySelector('img'));
      var title = cleanTitle(a.getAttribute('title') || a.textContent || (im && im.getAttribute('alt')) || '');
      if (!title) return;
      seen[u] = 1;
      out.push({
        source: 'hentai20', id: slugOf(u), title: title,
        cover: absolute(firstSrc(im), url), url: u,
        ref: 'https://hentai20.io/', adult: true
      });
    });
    var next = doc.querySelector('link[rel="next"], a.next.page-numbers, .pagination a.next');
    return { items: out, more: !!next && out.length > 0 };
  }
  async function hentai20Detail(item) {
    var doc = h20Doc(await page(item.url, 30000, null, 'https://hentai20.io/'));
    if (!doc) throw new Error('Hentai20 returned no title');
    var title = cleanTitle((doc.querySelector('.entry-title, .seriestuheader h1, h1') || {}).textContent || item.title);
    var coverIm = doc.querySelector('.seriestucontl .thumb img, .thumb img, .summary_image img');
    var cover = absolute(firstSrc(coverIm), item.url);
    if (!cover) {
      var og = doc.querySelector('meta[property="og:image"]');
      cover = og ? absolute(og.getAttribute('content'), item.url) : '';
    }
    var descEl = doc.querySelector('.summary__content, .summary_content, .seriestucontent .entry-content, .description-summary');
    var desc = descEl ? stripHtml(descEl.textContent).slice(0, 1200) : '';
    if (!desc) {
      var meta = doc.querySelector('meta[name="description"]');
      desc = meta ? stripHtml(meta.getAttribute('content')).slice(0, 900) : '';
    }
    var tags = [];
    $$('.seriestugenre a, .genres a', doc).forEach(function (a) {
      var t = stripHtml(a.textContent);
      if (t && tags.indexOf(t) < 0 && tags.length < 12) tags.push(t);
    });
    var chapters = [], seen = {};
    function pushChapter(u, label, no) {
      u = absolute(u, item.url).replace(/#.*$/, '');
      if (!u || !/^https:\/\/hentai20\.io\/[^/?#]+-chapter-[\d.]+\/?$/i.test(u)) return;
      if (seen[u]) return;
      var lb = cleanTitle(label || ('Chapter ' + (no || '')));
      if (!lb || nonEnglishLabel(lb)) return;
      seen[u] = 1;
      var n = parseFloat(no);
      if (!isFinite(n)) n = chapterNoOf(lb, u);
      chapters.push({ id: u, url: u, title: lb, no: n, lang: 'en' });
    }
    $$('#chapterlist li', doc).forEach(function (li) {
      var a = li.querySelector('a[href]');
      if (!a) return;
      var label = (li.querySelector('.chapternum') || a).textContent || '';
      pushChapter(a.getAttribute('href'), label, li.getAttribute('data-num'));
    });
    if (!chapters.length) {
      $$('a[href*="-chapter-"]', doc).forEach(function (a) {
        pushChapter(a.getAttribute('href'), a.textContent, '');
      });
    }
    if (!chapters.length) {
      var art = doc.querySelector('article[id^="post-"], [id^="post-"]');
      var mid = art ? (String(art.id).match(/post-(\d+)/) || [])[1] : '';
      if (mid) {
        try {
          var adoc = h20Doc(await readNetRaw('https://hentai20.io/wp-admin/admin-ajax.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
            body: 'action=manga_get_chapters&manga=' + enc(mid), ms: 30000
          }));
          if (adoc) {
            $$('li', adoc).forEach(function (li) {
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
    var html = await page(chapter.url, 30000, null, 'https://hentai20.io/');
    var urls = [], seen = {};
    function add(raw) {
      var u = absolute(String(raw || '').replace(/\\\//g, '/'), chapter.url).replace(/^http:/i, 'https:');
      if (!u || seen[u] || !/^https:\/\/img\.hentai1\.io\/.+\/chapter-[^/]+\/.+\.(?:jpe?g|png|webp)$/i.test(u)) return;
      seen[u] = 1;
      urls.push(u);
    }
    var data = h20ReaderJSON(html);
    if (data && data.sources && data.sources.length) {
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
      Array.prototype.forEach.call(imgs, function (im) { add(firstSrc(im)); });
    }
    if (!urls.length) throw new Error('Hentai20 returned no pages');
    return urls;
  }

  /* --------------------------------------------------------- nhentai.net
     Official v2 JSON API. Every catalogue is scoped to language:english and
     re-verified against the English language tag; if the API or Cloudflare
     blocks the device, the same public HTML is parsed from /page. */
  var NH_API = 'https://nhentai.net/api/v2';
  var NH_EN = 12227;
  var NH_CACHE = {};
  async function nhJSON(path) {
    var j = await readNetJSON(NH_API + path);
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
  async function nhRenderCatalog(url) {
    var snap = snapHtml(await page(url, 30000, null, 'https://nhentai.net/'), url);
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
    var pageNo = Math.max(1, parseInt(opts.page, 10) || 1);
    var tab = opts.tab === 'recent' ? 'recent' : 'popular';
    var q = String(opts.q || '').trim();
    var genre = String(opts.genre || '').trim();
    try {
      var query = 'language:english' + (q ? ' ' + q : '') + (genre ? ' tag:"' + genre + '"' : '');
      var sort = (q || genre) ? 'popular' : (tab === 'recent' ? 'date' : 'popular');
      var j = await nhJSON('/search?query=' + enc(query) + '&page=' + pageNo + '&sort=' + sort);
      var got = nhList(j);
      got.more = pageNo < Number(j.num_pages || 0);
      return { items: got.list.filter(nhEnglish).map(nhItem), more: got.more };
    } catch (e) {
      var htmlUrl;
      if (q || genre) {
        htmlUrl = 'https://nhentai.net/search/?q=' + enc(('language:english ' + (q || '') + (genre ? ' tag:"' + genre + '"' : '')).trim()) + '&sort=popular' + (pageNo > 1 ? '&page=' + pageNo : '');
      } else if (tab === 'recent') {
        htmlUrl = 'https://nhentai.net/' + (pageNo > 1 ? '?page=' + pageNo : '');
      } else {
        htmlUrl = 'https://nhentai.net/';
      }
      return await nhRenderCatalog(htmlUrl);
    }
  }
  async function nhentaiDetail(item) {
    var id = String(item.id || '').replace(/\D+/g, '');
    if (!id) id = (String(item.url).match(/\/g\/(\d+)/) || [])[1] || '';
    if (!id) throw new Error('nhentai title missing');
    var d = NH_CACHE[id];
    if (!d || Date.now() - d.t > 600000) {
      var g = null;
      try { g = await nhJSON('/galleries/' + id); } catch (e) {}
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
        var doc = h20Doc(await page(item.url, 30000, null, 'https://nhentai.net/'));
        if (!doc) throw new Error('nhentai returned no title');
        var english = !!doc.querySelector('a[href*="/language/english/"]');
        if (!english) throw new Error('nhentai title is not English');
        var imgs = [];
        $$('#thumbnail-container img, .thumb-container img, .gallerythumb img, img', doc).forEach(function (im) {
          var s = absolute(firstSrc(im), item.url);
          if (!/^https:\/\/t\d?\.nhentai\.net\/galleries\//i.test(s)) return;
          var full = s.replace(/^https:\/\/t(\d?)\.nhentai\.net\//i, 'https://i$1.nhentai.net/');
          full = full.replace(/(\d+)t\.(webp|jpg|png)$/i, '$1.$2');
          if (imgs.indexOf(full) < 0) imgs.push(full);
        });
        var t2 = cleanTitle((doc.querySelector('h1, .title') || {}).textContent || '') || item.title;
        var og2 = doc.querySelector('meta[property="og:image"]');
        d = {
          g: null, pages: imgs, t: Date.now(), title: t2,
          cover: og2 ? absolute(og2.getAttribute('content'), item.url) : (item.cover || ''),
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
      search: function (q) { return 'https://comix.to/browse?q=' + enc(q); },
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
      home: 'https://tapas.io/comics?sort=popular',
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
      catalog: mangafireCatalog,
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
  var adultAdapters = {};
  function activeProviders() {
    return state.adultMode ? ADULT_PROVIDERS : NATIVE_PROVIDERS;
  }
  function registerAdultAdapter(id, adapter) {
    if (!id || !adapter) return;
    adultAdapters[id] = adapter;
    var p = providerById(id);
    if (p) {
      if (adapter.catalog) p.catalog = adapter.catalog;
      if (adapter.detail) p.detail = adapter.detail;
      if (adapter.chapter) p.chapter = adapter.chapter;
    }
  }
  function providerById(id) {
    var all = NATIVE_PROVIDERS.concat(ADULT_PROVIDERS);
    return all.filter(function (p) { return p.id === id; })[0] || null;
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
  function sourceRef(source) {
    if (source === 'md') return 'https://mangadex.org/';
    if (source === 'wt') return 'https://www.webtoons.com/';
    var p = providerById(source);
    return p ? p.ref : '';
  }
  function safeSources() {
    return [{ id: 'md', name: 'MangaDex', short: 'MD' }, { id: 'wt', name: 'WEBTOON', short: 'WT' }]
      .concat(NATIVE_PROVIDERS.filter(function (p) { return !p.adult; }).map(function (p) { return { id: p.id, name: p.name, short: p.short }; }));
  }
  function adultSources() {
    return ADULT_PROVIDERS.map(function (p) { return { id: p.id, name: p.name, short: p.short }; });
  }
  function allSources() {
    return state.adultMode ? adultSources() : safeSources();
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
  async function nativeSnap(p, url, kind) {
    var html = await page(url, 34000, null, p.ref);
    if (!html || html.length < 400) throw new Error('source returned an empty page');
    /* A page can mention "Enable JavaScript" in a noscript block and still be
       fully server-rendered. Only treat a challenge as blocking when the body
       also has no real links to read. */
    if (/Just a moment|challenge-platform|cf-mitigated/i.test(html) && !/<a\s[^>]*href=/i.test(html)) {
      throw new Error('source is blocking automated reads right now');
    }
    var snap = snapHtml(html, url);
    if (kind === 'catalog' && !snap.anchors.length) throw new Error('source returned a client shell');
    return snap;
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
        cover: a.i || '', url: u, ref: p.ref, adult: !!p.adult
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
    var seen = {}, seenNo = {};
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
    if (!urls.length && snap.html) {
      var raw = String(snap.html).replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/&amp;/g, '&');
      var re = /https?:\/\/[^"'\s<>\\]+?\.(?:jpe?g|png|webp|avif)(?:\?[^"'\s<>\\]*)?/gi, m;
      while ((m = re.exec(raw)) && urls.length < 400) push(m[0].replace(/[),.;]+$/, ''), true);
    }
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

  /* --- generic provider adapters --- */
  async function hiveCatalog(q) {
    var snap = await nativeSnap(providerById('hive'), 'https://hivetoons.org/series', 'catalog');
    var out = [], seen = {};
    (snap.anchors || []).forEach(function (a) {
      var u = String(a.h || '').replace(/[?#].*$/, '').replace(/\/+$/, '');
      if (!/^https:\/\/hivetoons\.org\/series\/[^/?#]+$/i.test(u)) return;
      if (seen[u]) return;
      var title = cleanTitle(a.a || '');
      if (!title || /^(read series|series|browse|home)$/i.test(title)) return;
      seen[u] = 1;
      out.push({ source: 'hive', id: slugOf(u), title: title, cover: a.i || '', url: u, ref: 'https://hivetoons.org/', adult: false });
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
  async function comixCatalog(q) {
    var url = q ? 'https://comix.to/browse?q=' + enc(q) : 'https://comix.to/';
    var snap = await nativeSnap(providerById('comix'), url, 'catalog');
    var out = [], seen = {};
    (snap.anchors || []).forEach(function (a) {
      var u = String(a.h || '').replace(/[?#].*$/, '');
      if (!/^https:\/\/comix\.to\/title\/[^/?#]+$/i.test(u)) return;
      if (seen[u]) return;
      seen[u] = 1;
      var title = cleanTitle(a.a || '') || comixSlugTitle(u);
      if (!title) return;
      out.push({ source: 'comix', id: slugOf(u), title: title, cover: a.i || '', url: u, ref: 'https://comix.to/', adult: false });
    });
    if (q) {
      var needle = q.toLowerCase();
      out = out.filter(function (x) { return x.title.toLowerCase().indexOf(needle) >= 0; });
    }
    return out.slice(0, 48);
  }

  /* --- ToonSutra (public app API) --- */
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
      desc: stripHtml(c.comic_discription || c.description || c.synopsis || ''),
      author: String(c.author_name || c.publisher_name || ''),
      tags: (c.comic_genre_list || c.genre_list || []).map(function (g) { return g.genre_name || g.name || ''; }).filter(Boolean),
      url: 'https://www.toonsutra.com/comic/' + enc(id), ref: 'https://www.toonsutra.com/', adult: false
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
      desc: stripHtml(c.description || c.comic_discription || item.desc || ''),
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

  /* --- AllManga (public GraphQL) --- */
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
      cover: amCover(x.thumbnail), desc: stripHtml(x.description || ''),
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
        id: String(n), no: parseFloat(n), title: 'Chapter ' + n,
        url: 'https://allmanga.to/manga/' + enc(item.id) + '/chapter-' + enc(String(n)) + '-sub', lang: 'en'
      };
    }).sort(function (a, b) { return (a.no || 0) - (b.no || 0); });
    return {
      source: 'allmanga', id: item.id, title: cleanTitle(m.englishName || m.name || item.title),
      cover: amCover(m.thumbnail) || item.cover, desc: stripHtml(m.description || item.desc || ''),
      author: 'AllManga', genre: '', tags: (m.genres || []).slice(0, 8),
      url: item.url, ref: 'https://allmanga.to/', chapters: chapters, more: false, chapterMode: 'native'
    };
  }
  async function allmangaChapter(detail, chapter) {
    try {
      var g = await amGql('query($mangaId:String!,$translationType:VaildTranslationTypeMangaEnumType!,$chapterString:String!,$page:Int,$limit:Int,$offset:Int,$queryAt:String){chapterPages(mangaId:$mangaId,translationType:$translationType,chapterString:$chapterString,page:$page,limit:$limit,offset:$offset,queryAt:$queryAt){edges{pictureUrls pictureUrlsProcessed pictureUrlHead}pageInfo{total}}}',
        { mangaId: detail.id, translationType: 'sub', chapterString: String(chapter.id), limit: 100, offset: 0, queryAt: new Date().toISOString() });
      var edges = (((g.chapterPages || {}).edges) || []);
      var urls = [];
      edges.forEach(function (e) {
        var head = String(e.pictureUrlHead || '');
        var list = e.pictureUrls;
        if (typeof list === 'string') { try { list = JSON.parse(list); } catch (x) { list = [list]; } }
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
    throw new Error('AllManga gates this chapter behind a challenge. Try another source or chapter.');
  }

  /* --- Tapas --- */
  function tapasSeriesUrl(u) {
    var m = /\/series\/([^/?#]+)/i.exec(String(u || ''));
    return m ? 'https://tapas.io/series/' + m[1] : String(u || '');
  }
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
    var text = cleanTitle(a.a || a.t || '');
    if (text && /[a-z]{3,}/i.test(text) && !/^(read|tapas|series|comics?|home|search|login|sign up)$/i.test(text)) return text;
    return tapasImageTitle(a.i) || text;
  }
  async function tapasCatalog(q) {
    /* Tapas' HTML shell only contains skeleton cards; its grid is hydrated
       from a public JSON catalogue. Use that API so Android has a native,
       server-rendered catalogue with covers and real titles. */
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
    var snap = await nativeSnap(providerById('tapas'), url, 'detail');
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
      chapters.push({ id: m[1], no: no, title: 'Episode ' + no, url: 'https://tapas.io/episode/' + m[1], lang: 'en' });
    });
    var uniq = {};
    chapters.forEach(function (c) { uniq[c.no] = 1; });
    if (chapters.length > 1 && Object.keys(uniq).length === 1) {
      chapters.forEach(function (c, i) { c.no = i + 1; c.title = 'Episode ' + c.no; });
    }
    if (!chapters.length) throw new Error('Tapas returned no episode list');
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
    var snap = await nativeSnap(providerById('tapas'), chapter.url, 'chapter');
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

  /* --- Tappytoon (Next.js state; the reader manifest needs a browser
         signature, so locked chapters explain themselves in-app) --- */
  function jsonAttr(html, id) {
    try {
      var doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
      var el = doc.getElementById(id);
      return el ? JSON.parse(el.textContent) : null;
    } catch (e) { return null; }
  }
  function tappyState(html) {
    var j = jsonAttr(html, '__NEXT_DATA__');
    return (j && j.props && j.props.initialState) || null;
  }
  function tappyCard(c) {
    return {
      source: 'tappytoon', id: String(c.slug || c.id || ''), title: cleanTitle(c.title) || 'Untitled',
      cover: String(c.coverImageUrl || c.thumbnailUrl || ''), desc: stripHtml(c.longDescription || c.synopsis || ''),
      author: (c.authors || []).map(function (a) { return a.name || a; }).filter(Boolean).join(', '),
      tags: (c.genres || []).map(function (g) { return g.name || g; }).filter(Boolean),
      url: 'https://www.tappytoon.com/en/book/' + enc(String(c.slug || c.id || '')),
      ref: 'https://www.tappytoon.com/', adult: !!c.isMature
    };
  }
  async function tappyCatalog(q) {
    var snap = await nativeSnap(providerById('tappytoon'), 'https://www.tappytoon.com/en/comics/discover', 'catalog');
    var st = tappyState(snap.html || '');
    if (!st) throw new Error('Tappytoon returned no catalogue');
    var comics = (st.entities && st.entities.comics) || {};
    var list = Object.keys(comics).map(function (k) { return tappyCard(comics[k]); });
    if (q) {
      var needle = q.toLowerCase();
      list = list.filter(function (it) { return it.title.toLowerCase().indexOf(needle) >= 0; });
    }
    return list.filter(function (x) { return x.id; }).slice(0, 48);
  }
  async function tappyDetail(item) {
    var snap = await nativeSnap(providerById('tappytoon'), item.url, 'detail');
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
      cover: String(c.coverImageUrl || item.cover || ''), desc: stripHtml(c.longDescription || c.synopsis || item.desc || ''),
      author: (c.authors || []).map(function (a) { return a.name || a; }).filter(Boolean).join(', '),
      genre: '', tags: (c.genres || []).map(function (g) { return g.name || g; }).filter(Boolean),
      url: item.url, ref: 'https://www.tappytoon.com/', chapters: chapters,
      more: false, chapterMode: 'native'
    };
  }
  async function tappyChapter(_detail, chapter) {
    var snap = await nativeSnap(providerById('tappytoon'), chapter.url, 'chapter');
    var urls = parseNativeChapter(snap, providerById('tappytoon'), chapter.url);
    if (!urls.length) throw new Error('Tappytoon locks this chapter in its own signed viewer. Try a free chapter.');
    return urls;
  }

  /* --- MangaFire (catalogue only; page API needs a browser signature) --- */
  async function mangafireCatalog(q) {
    var url = q ? 'https://mangafire.to/filter?keyword=' + enc(q) : 'https://mangafire.to/';
    var snap = await nativeSnap(providerById('mangafire'), url, 'catalog');
    return parseNativeCatalog(snap, providerById('mangafire'));
  }
  async function mangafireDetail(item) {
    var snap = await nativeSnap(providerById('mangafire'), item.url, 'detail');
    var d = parseNativeDetail(snap, item, providerById('mangafire'));
    if (!d.chapters.length) throw new Error('MangaFire hides its chapter list behind a signed request. Try another source.');
    return d;
  }
  async function mangafireChapter() {
    throw new Error('MangaFire hides its page list behind a signed request. Try another source.');
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
    var pageNo = append ? (state.page || 1) + 1 : 1;
    if (!append) { state.items = []; state.offset = 0; }
    paintBody();
    try {
      var list = null, more = false;
      if (p.catalog) {
        try {
          if (state.adultMode) {
            var got = await p.catalog({ q: state.q, genre: state.genre, tab: state.tab, page: pageNo });
            list = (got && got.items) || got || [];
            more = !!(got && got.more);
          } else {
            list = await p.catalog(state.q);
          }
        } catch (e) { list = null; }
      }
      if (!list) {
        var url = state.q && p.search ? p.search(state.q) : p.home;
        var snap = await nativeSnap(p, url, 'catalog');
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
      state.page = pageNo;
    } catch (e) {
      if (req !== state.req) return;
      if (!append) { state.items = []; state.total = 0; }
      if (e && e.name === 'AbortError') return;
      toast((e && e.message) ? p.name + ': ' + e.message : p.name + ' is unavailable');
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
    var snap = await nativeSnap(p, item.url, 'detail');
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
      desc: detail.desc, seriesUrl: detail.url, ref: detail.ref, chapterId: chapter.url,
      chapterLabel: chapter.title, page: 0
    });
    var p = providerById(detail.source);
    try {
      var urls = null;
      if (p.chapter) {
        try { urls = await p.chapter(detail, chapter); } catch (e0) { urls = null; }
      }
      if (!urls || !urls.length) {
        var snap = await nativeSnap(p, chapter.url, 'chapter');
        urls = parseNativeChapter(snap, p, chapter.url);
      }
      if (!urls.length) throw new Error('No pages found');
      readerImages(urls, p.ref);
    } catch (e) {
      var body = readerEl && $('#rdRBody', readerEl);
      if (body) body.innerHTML = '<div class="rd-empty" style="margin:60px auto;max-width:520px">This chapter could not be loaded from ' +
        esc(sourceName(detail.source)) + '.<br><span style="font-size:12px;color:#6f7681">No external browser is opened. Try another chapter or source.</span><br><br>' +
        '<button class="rd-btn gold" type="button" id="rdRClose">Back to chapters</button></div>';
      var b = readerEl && $('#rdRClose', readerEl);
      if (b) b.onclick = function () { closeReader(); };
    }
  }

  /* ---------------------------------------------------------------- toast */
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
      '.rd-shell{max-width:1480px;margin:0 auto;padding:18px 16px 96px;animation:rdFadeIn .34s cubic-bezier(.16,1,.3,1) both}',
      '@keyframes rdFadeIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}',
      '.rd-shell.rd-adult-shell{--rd-accent:#f43f5e;--rd-accent-bg:rgba(244,63,94,.14);--rd-accent-border:rgba(244,63,94,.38)}',
      '.rd-hero{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;flex-wrap:wrap;margin:0 0 18px}',
      '.rd-hero h1{font-size:clamp(26px,4.2vw,42px);line-height:1.02;letter-spacing:-.035em;margin:0 0 6px;font-weight:900}',
      '.rd-hero h1 em{font-style:normal;color:var(--rd-accent,#ffc105)}',
      '.rd-hero p{color:#9ca3b0;margin:0;max-width:620px;font-size:13px;line-height:1.55}',
      '.rd-kicker{display:inline-flex;align-items:center;gap:6px;font-size:10px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--rd-accent,#ffc105);margin-bottom:6px}',
      '.rd-kicker.safe{color:#41e88a}',
      '.rd-hero .rd-stat{display:flex;gap:7px;flex-wrap:wrap}',
      '.rd-stat span{border:1px solid rgba(255,255,255,.09);background:rgba(19,21,28,.75);backdrop-filter:blur(12px);border-radius:999px;padding:6px 11px;font-size:10.5px;font-weight:700;color:#aeb5c2;letter-spacing:.03em}',
      '.rd-source{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;background:rgba(17,19,26,.82);backdrop-filter:blur(14px);border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:4px;margin:0 0 14px}',
      '.rd-source::-webkit-scrollbar{display:none}',
      '.rd-source button{flex:0 0 auto;border:0;background:transparent;color:#9aa1ae;font-weight:700;font-size:12.5px;padding:9px 15px;border-radius:10px;cursor:pointer;transition:transform .2s cubic-bezier(.16,1,.3,1),background .2s,color .2s;white-space:nowrap}',
      '.rd-source button:hover{color:#fff}',
      '.rd-source button.on{background:var(--rd-accent,#ffc105);color:#0b0c10;box-shadow:0 6px 18px rgba(255,193,5,.25)}',
      '.rd-adult-shell .rd-source button.on{color:#fff;box-shadow:0 6px 18px rgba(244,63,94,.32)}',
      '.rd-tools{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:0 0 12px}',
      '.rd-filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 14px}',
      '.rd-filters label{display:flex;align-items:center;gap:8px;background:rgba(19,21,28,.8);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.09);border-radius:12px;padding:7px 11px;font-size:10.5px;font-weight:700;color:#8f96a2;letter-spacing:.04em;text-transform:uppercase}',
      '.rd-filters select{background:transparent;border:0;color:#eceef2;font-size:12.5px;font-weight:600;outline:none;max-width:180px;cursor:pointer}',
      '.rd-filters select option{background:#121419;color:#eceef2}',
      '.rd-filters .rd-btn{padding:8px 12px;font-size:11.5px}',
      '.rd-fnote{color:#7e8490;font-size:11.5px;margin-left:auto}',
      '.rd-search{flex:1 1 280px;display:flex;gap:8px;min-width:220px;align-items:center;background:rgba(19,21,28,.86);backdrop-filter:blur(14px);border:1px solid rgba(255,255,255,.1);border-radius:14px;padding:4px 5px 4px 13px;transition:border-color .22s,box-shadow .22s}',
      '.rd-search:focus-within{border-color:var(--rd-accent,#ffc105);box-shadow:0 0 0 3px var(--rd-accent-bg,rgba(255,193,5,.14))}',
      '.rd-search input{flex:1;background:transparent;border:0;color:#f2f4f8;padding:8px 4px;font-size:13.5px;outline:none;min-width:0}',
      '.rd-search input::placeholder{color:#747b88}',
      '.rd-btn{border:1px solid rgba(255,255,255,.1);background:rgba(24,27,36,.88);color:#e7e9ee;border-radius:11px;padding:9px 15px;font-size:12.5px;font-weight:700;cursor:pointer;transition:transform .2s cubic-bezier(.16,1,.3,1),background .2s,border-color .2s}',
      '.rd-btn:hover{border-color:rgba(255,255,255,.22);background:rgba(34,38,50,.94)}',
      '.rd-btn:active{transform:scale(.96)}',
      '.rd-btn.gold{background:var(--rd-accent,#ffc105);border-color:var(--rd-accent,#ffc105);color:#0d0e12;font-weight:800}',
      '.rd-adult-shell .rd-btn.gold{color:#fff}',
      '.rd-btn.ghost{background:transparent}',
      '.rd-rating{display:flex;gap:6px;flex-wrap:wrap}',
      '.rd-rating button{border:1px solid rgba(255,255,255,.09);background:rgba(19,21,28,.82);color:#9399a4;border-radius:999px;padding:8px 13px;font-size:11.5px;font-weight:700;cursor:pointer;transition:all .2s}',
      '.rd-rating button.on{border-color:var(--rd-accent,#ffc105);color:var(--rd-accent,#ffc105);background:var(--rd-accent-bg,rgba(255,193,5,.1))}',
      '.rd-chips{display:flex;gap:7px;flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;margin:0 0 18px;padding-bottom:3px}',
      '.rd-chips::-webkit-scrollbar{display:none}',
      '.rd-chips button{flex:0 0 auto;border:1px solid rgba(255,255,255,.08);background:rgba(19,21,28,.78);color:#b9bec8;border-radius:999px;padding:7px 13px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;transition:all .2s cubic-bezier(.16,1,.3,1)}',
      '.rd-chips button:hover{border-color:rgba(255,255,255,.22);color:#fff}',
      '.rd-chips button.on{background:var(--rd-accent,#ffc105);border-color:var(--rd-accent,#ffc105);color:#0b0c10;font-weight:800}',
      '.rd-adult-shell .rd-chips button.on{color:#fff}',
      '.rd-sec{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 12px}',
      '.rd-sec h2{font-size:16px;font-weight:800;letter-spacing:-.015em;margin:0}',
      '.rd-sec .muted{color:#7e8490;font-size:11.5px;font-weight:600}',
      '.rd-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(124px,1fr));gap:12px}',
      '@media(min-width:640px){.rd-grid{grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:15px}}',
      '.rd-card{text-align:left;border:0;background:transparent;color:inherit;cursor:pointer;padding:0;min-width:0;transition:transform .28s cubic-bezier(.16,1,.3,1)}',
      '.rd-card:hover{transform:translateY(-4px)}',
      '.rd-card:active{transform:scale(.97)}',
      '.rd-cover{position:relative;display:block;aspect-ratio:2/3;border-radius:13px;overflow:hidden;background:#141720;border:1px solid rgba(255,255,255,.08);box-shadow:0 10px 26px rgba(0,0,0,.42);transition:border-color .28s,box-shadow .28s}',
      '.rd-cover img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .42s cubic-bezier(.16,1,.3,1),opacity .3s}',
      '.rd-card:hover .rd-cover img{transform:scale(1.06)}',
      '.rd-card:hover .rd-cover{border-color:var(--rd-accent-border,rgba(255,193,5,.45));box-shadow:0 16px 34px rgba(0,0,0,.55),0 0 22px var(--rd-accent-bg,rgba(255,193,5,.14))}',
      '.rd-badge{position:absolute;left:7px;top:7px;background:rgba(8,9,13,.82);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.12);border-radius:7px;padding:3px 7px;font-size:9px;font-weight:800;letter-spacing:.08em;color:#ffd23f}',
      '.rd-badge.green{color:#41e88a;border-color:rgba(65,232,138,.3)}',
      '.rd-badge.adult{color:#fda4af;border-color:rgba(244,63,94,.4);background:rgba(40,10,18,.84)}',
      '.rd-card b{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:12.5px;font-weight:700;line-height:1.3;margin:8px 0 2px}',
      '.rd-card span{display:block;color:#7f8590;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.rd-skel .rd-cover{background:linear-gradient(110deg,#151822 8%,#222738 18%,#151822 33%);background-size:200% 100%;animation:rdShimmer 1.35s linear infinite}',
      '@keyframes rdShimmer{to{background-position:-200% 0}}',
      '.rd-empty{color:#8b909a;padding:42px 14px;text-align:center;border:1px dashed rgba(255,255,255,.12);border-radius:16px;background:rgba(16,18,25,.45)}',
      '.rd-more{display:flex;justify-content:center;margin:24px 0 0}',
      '.rd-row{display:flex;gap:12px;overflow-x:auto;padding:2px 0 16px;scrollbar-width:none}',
      '.rd-row::-webkit-scrollbar{display:none}',
      '.rd-row .rd-item{flex:0 0 116px}',
      '.rd-item{text-align:left;border:0;background:transparent;color:inherit;cursor:pointer;padding:0;min-width:0;transition:transform .24s cubic-bezier(.16,1,.3,1)}',
      '.rd-item:hover{transform:translateY(-3px)}',
      '.rd-item .rd-cover{position:relative;display:block;aspect-ratio:2/3;border-radius:12px;overflow:hidden;background:#141720;border:1px solid rgba(255,255,255,.08)}',
      '.rd-item .rd-cover img{width:100%;height:100%;object-fit:cover;display:block}',
      '.rd-item b{display:block;font-size:12px;font-weight:700;margin:7px 0 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.rd-item span{display:block;color:#7f8590;font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.rd-detail{max-width:1100px;margin:0 auto;padding:4px 0 36px;animation:rdFadeIn .3s cubic-bezier(.16,1,.3,1) both}',
      '.rd-back{border:1px solid rgba(255,255,255,.11);background:rgba(20,23,32,.86);backdrop-filter:blur(10px);color:#e6e8ee;border-radius:11px;padding:8px 13px;font-size:12.5px;font-weight:700;cursor:pointer;margin:0 0 16px}',
      '.rd-dhead{display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap;margin:0 0 22px}',
      '.rd-dcover{flex:0 0 132px;max-width:132px;aspect-ratio:2/3;border-radius:14px;overflow:hidden;border:1px solid rgba(255,255,255,.12);box-shadow:0 18px 46px rgba(0,0,0,.55);background:#14161b}',
      '@media(min-width:640px){.rd-dcover{flex:0 0 190px;max-width:190px}}',
      '.rd-dcover img{width:100%;height:100%;object-fit:cover;display:block}',
      '.rd-dinfo{flex:1 1 260px;min-width:220px}',
      '.rd-dinfo h1{font-size:clamp(22px,3.6vw,38px);letter-spacing:-.03em;line-height:1.06;margin:0 0 7px}',
      '.rd-dinfo .by{color:#a8aeb9;font-size:13px;margin:0 0 10px}',
      '.rd-dmeta{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 14px}',
      '.rd-dmeta span{border:1px solid rgba(255,255,255,.1);background:rgba(19,22,30,.75);color:#b2b8c4;border-radius:999px;padding:5px 10px;font-size:10.5px;font-weight:600}',
      '.rd-desc{color:#b4bac4;font-size:13px;line-height:1.62;margin:0 0 16px;max-width:740px;max-height:130px;overflow:auto}',
      '.rd-dactions{display:flex;gap:9px;flex-wrap:wrap;margin:0 0 18px}',
      '.rd-chapbar{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin:0 0 12px}',
      '.rd-chapbar h2{font-size:16px;margin:0}',
      '.rd-chapsearch{background:rgba(18,20,28,.85);border:1px solid rgba(255,255,255,.1);color:#e8eaee;border-radius:10px;padding:8px 12px;font-size:12.5px;outline:none;min-width:160px}',
      '.rd-chaps{border:1px solid rgba(255,255,255,.08);border-radius:14px;overflow:hidden;background:rgba(15,17,23,.85)}',
      '.rd-chap{display:flex;align-items:center;gap:12px;width:100%;text-align:left;border:0;border-bottom:1px solid rgba(255,255,255,.06);background:transparent;color:inherit;padding:12px 14px;cursor:pointer;transition:background .16s}',
      '.rd-chap:last-child{border-bottom:0}',
      '.rd-chap:hover{background:rgba(255,255,255,.05)}',
      '.rd-chap .n{flex:0 0 66px;color:var(--rd-accent,#ffc105);font-weight:800;font-size:12px;letter-spacing:.03em}',
      '.rd-chap .t{flex:1;min-width:0;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.rd-chap .g{flex:0 0 110px;color:#777e8a;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:right}',
      '.rd-chap .d{flex:0 0 74px;color:#666d78;font-size:10.5px;text-align:right}',
      '.rd-chap .done{color:#43d17c;font-size:11px;flex:0 0 auto}',
      '.rd-loading{padding:36px 0;text-align:center;color:#8b919c;font-size:13px}',
      '.rd-spin{display:inline-block;width:18px;height:18px;border:2px solid #2c313b;border-top-color:var(--rd-accent,#ffc105);border-radius:50%;animation:rdSpin .8s linear infinite;vertical-align:-4px;margin-right:9px}',
      '@keyframes rdSpin{to{transform:rotate(360deg)}}',
      /* Auto-hiding Floating Multi-Mode Reader Overlay */
      '.rd-reader{position:fixed;inset:0;z-index:260;background:#050609;display:flex;flex-direction:column;animation:rdIn .24s cubic-bezier(.16,1,.3,1) both;user-select:none}',
      '@keyframes rdIn{from{opacity:0;transform:scale(.985)}to{opacity:1;transform:none}}',
      '.rd-rbar{position:fixed;top:0;left:0;right:0;z-index:12;display:flex;align-items:center;gap:8px;padding:calc(10px + env(safe-area-inset-top)) 12px 10px;background:rgba(10,12,18,.84);border-bottom:1px solid rgba(255,255,255,.09);backdrop-filter:blur(22px);-webkit-backdrop-filter:blur(22px);transition:transform .32s cubic-bezier(.16,1,.3,1),opacity .28s}',
      '.rd-reader.hud-hidden .rd-rbar{transform:translateY(-105%);opacity:0;pointer-events:none}',
      '.rd-rbar button{border:1px solid rgba(255,255,255,.11);background:rgba(24,27,36,.82);color:#edf0f7;border-radius:10px;min-width:36px;height:36px;font-size:14px;font-weight:700;line-height:1;cursor:pointer;padding:0 10px;transition:transform .16s,background .16s}',
      '.rd-rbar button:active{transform:scale(.94)}',
      '.rd-rbar button:disabled{opacity:.32;cursor:default}',
      '.rd-rtitle{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}',
      '.rd-rtitle b{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.rd-rtitle span{font-size:10.5px;color:#8c93a3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.rd-rpages{font-size:11px;font-weight:700;color:#ffd23f;background:rgba(255,193,5,.12);border:1px solid rgba(255,193,5,.26);border-radius:999px;padding:4px 9px;white-space:nowrap}',
      '.rd-rbody{flex:1 1 auto;overflow:auto;-webkit-overflow-scrolling:touch;background:#050609;position:relative;padding-top:58px;padding-bottom:92px}',
      '.rd-rbody.mode-single,.rd-rbody.mode-spread{overflow:hidden;display:flex;align-items:center;justify-content:center;padding:0}',
      '.rd-strip{max-width:860px;margin:0 auto;padding:0 0 28px;display:flex;flex-direction:column;align-items:center;transform-origin:top center;transition:width .2s ease}',
      '.rd-strip.fit-height img{width:auto;max-height:calc(100vh - 110px);max-width:100%;object-fit:contain;margin:6px auto}',
      '.rd-strip img{display:block;width:100%;height:auto;background:#0d0f15;min-height:100px}',
      '.rd-strip img.rd-on{opacity:1;transition:opacity .24s}',
      '.rd-strip img.rd-fail{min-height:200px;opacity:1}',
      '.rd-stage{position:relative;width:100%;height:100%;display:flex;align-items:center;justify-content:center;overflow:auto;padding:56px 10px 88px}',
      '.rd-page-wrap{display:flex;align-items:center;justify-content:center;gap:8px;max-width:100%;max-height:100%;animation:rdPageIn .24s cubic-bezier(.16,1,.3,1) both;transform-origin:center center;transition:transform .2s ease}',
      '@keyframes rdPageIn{from{opacity:0;transform:translateX(14px) scale(.985)}to{opacity:1;transform:none}}',
      '.rd-page-wrap img{display:block;border-radius:4px;box-shadow:0 18px 46px rgba(0,0,0,.65);background:#0d0f15}',
      '.rd-stage.fit-width .rd-page-wrap img{max-width:96vw;max-height:none;width:auto;height:auto}',
      '.rd-stage.fit-height .rd-page-wrap img{max-height:calc(100vh - 140px);max-width:96vw;width:auto;height:auto;object-fit:contain}',
      '.rd-stage.spread-mode.fit-height .rd-page-wrap img{max-width:47vw;max-height:calc(100vh - 140px)}',
      '.rd-stage.spread-mode.fit-width .rd-page-wrap img{max-width:47vw;height:auto}',
      '.rd-tap-prev,.rd-tap-next{position:fixed;top:64px;bottom:96px;width:24%;z-index:6;cursor:pointer;background:transparent;border:0}',
      '.rd-tap-prev{left:0}.rd-tap-next{right:0}',
      '.rd-toolbar{position:fixed;left:50%;bottom:calc(14px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:14;width:min(94vw,640px);background:rgba(14,16,24,.88);border:1px solid rgba(255,255,255,.12);border-radius:18px;padding:10px 12px;backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);box-shadow:0 20px 50px rgba(0,0,0,.65);display:flex;flex-direction:column;gap:9px;transition:transform .32s cubic-bezier(.16,1,.3,1),opacity .26s}',
      '.rd-reader.hud-hidden .rd-toolbar{transform:translate(-50%,130%);opacity:0;pointer-events:none}',
      '.rd-tb-row{display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap}',
      '.rd-seg{display:inline-flex;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:3px;gap:2px}',
      '.rd-seg button{border:0;background:transparent;color:#9ea6b6;font-size:11px;font-weight:700;padding:6px 9px;border-radius:8px;cursor:pointer;transition:all .18s;white-space:nowrap}',
      '.rd-seg button.on{background:#ffc105;color:#0b0c10;font-weight:800}',
      '.rd-zoom-box{display:inline-flex;align-items:center;gap:4px}',
      '.rd-zoom-box button{border:1px solid rgba(255,255,255,.11);background:rgba(255,255,255,.06);color:#eef1f7;border-radius:8px;width:28px;height:28px;font-size:14px;font-weight:800;cursor:pointer}',
      '.rd-zoom-box span{font-size:11px;font-weight:700;color:#b8c0ce;min-width:38px;text-align:center}',
      '.rd-slider-row{display:flex;align-items:center;gap:10px}',
      '.rd-slider-row span{font-size:11px;font-weight:700;color:#9ea6b6;min-width:52px;text-align:center}',
      '.rd-slider-row input[type=range]{flex:1;accent-color:#ffc105;height:4px;cursor:pointer}',
      /* Slide-Out Chapter Drawer */
      '.rd-cdrawer-bg{position:fixed;inset:0;z-index:20;background:rgba(0,0,0,.62);backdrop-filter:blur(4px);opacity:0;pointer-events:none;transition:opacity .26s}',
      '.rd-cdrawer-bg.open{opacity:1;pointer-events:auto}',
      '.rd-cdrawer{position:fixed;top:0;right:0;bottom:0;z-index:22;width:min(86vw,340px);background:rgba(14,16,23,.96);border-left:1px solid rgba(255,255,255,.1);backdrop-filter:blur(26px);display:flex;flex-direction:column;transform:translateX(104%);transition:transform .32s cubic-bezier(.16,1,.3,1);box-shadow:-20px 0 50px rgba(0,0,0,.7)}',
      '.rd-cdrawer.open{transform:translateX(0)}',
      '.rd-cdrawer-head{display:flex;align-items:center;justify-content:space-between;padding:calc(14px + env(safe-area-inset-top)) 14px 12px;border-bottom:1px solid rgba(255,255,255,.08)}',
      '.rd-cdrawer-head b{font-size:14px;font-weight:800}',
      '.rd-cdrawer-head button{border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.06);color:#fff;width:32px;height:32px;border-radius:9px;font-size:17px;cursor:pointer}',
      '.rd-cdrawer-search{margin:10px 12px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:8px 11px;color:#fff;font-size:12.5px;outline:none}',
      '.rd-cdrawer-list{flex:1;overflow-y:auto;padding:4px 10px calc(24px + env(safe-area-inset-bottom))}',
      '.rd-cdrawer-item{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;text-align:left;border:1px solid transparent;background:transparent;color:#d6dbe5;padding:10px 11px;border-radius:10px;font-size:12.5px;cursor:pointer;margin-bottom:4px;transition:background .16s}',
      '.rd-cdrawer-item:hover{background:rgba(255,255,255,.06)}',
      '.rd-cdrawer-item.on{background:rgba(255,193,5,.14);border-color:rgba(255,193,5,.38);color:#ffc105;font-weight:800}',
      '.rd-rend{max-width:820px;margin:0 auto;padding:28px 20px calc(90px + env(safe-area-inset-bottom));text-align:center;color:#8b929e;font-size:13px}',
      '.rd-rend button{margin:12px 6px 0}',
      '.rd-rprog{position:fixed;left:0;right:0;bottom:0;height:3px;background:rgba(255,255,255,.08);z-index:15}',
      '.rd-rprog i{display:block;height:100%;width:0%;background:linear-gradient(90deg,#ffc105,#ff8a00);transition:width .16s linear}',
      '.rd-toast{position:fixed;left:50%;bottom:28px;transform:translate(-50%,14px);z-index:320;background:rgba(22,25,34,.94);backdrop-filter:blur(14px);border:1px solid rgba(255,255,255,.14);color:#f0f2f5;padding:10px 16px;border-radius:12px;font-size:12.5px;opacity:0;pointer-events:none;transition:transform .24s cubic-bezier(.16,1,.3,1),opacity .22s;max-width:88vw;text-align:center}',
      '.rd-toast.on{opacity:1;transform:translate(-50%,0)}',
      'body.rd-lock{overflow:hidden!important}',
      '@media(max-width:720px){.rd-fnote{display:none}.rd-chap .g{display:none}.rd-rpages{display:none}.rd-toolbar{padding:9px 10px}}',
      '@media(prefers-reduced-motion:reduce){.rd-shell,.rd-detail,.rd-reader,.rd-page-wrap,.rd-skel .rd-cover,.rd-spin{animation:none!important}.rd-card,.rd-rbar,.rd-toolbar,.rd-cdrawer,.rd-cdrawer-bg{transition:none!important}}'
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
    if (state.adultMode) {
      var ap0 = providerById(state.source) || ADULT_PROVIDERS[0];
      var tabBtns = (ap0.tabs || []).map(function (t) {
        return '<button type="button" data-rd-tab="' + t.c + '" class="' + (state.tab === t.c ? 'on' : '') + '">' + esc(t.n) + '</button>';
      }).join('');
      return '<div class="rd-shell rd-adult-shell" data-reading-mode="adult">' +
        '<div class="rd-hero"><div>' +
        '<span class="rd-kicker">18+ ISOLATED VAULT · READING</span>' +
        '<h1>18+ <em>Reading</em></h1>' +
        '<p>Isolated adult manga and doujinshi shelf with dedicated Hentai20 &amp; nHentai source switching. Completely separated from standard Reading and Kids.</p></div>' +
        '<div class="rd-stat"><span>Age-Gated</span><span>Isolated History</span><span>Multi-Mode Reader</span></div></div>' +
        '<div class="rd-source adult-src-switcher" role="tablist" aria-label="18+ Reading Sources">' +
        adultSources().map(function (s) {
          return '<button data-rd-source="' + s.id + '" role="tab" aria-selected="' + (state.source === s.id) + '" class="' + (state.source === s.id ? 'on' : '') + '">' + esc(s.name) + '</button>';
        }).join('') +
        '</div>' +
        (tabBtns ? '<div class="rd-tabs" role="group" aria-label="Catalogue">' + tabBtns + '</div>' : '') +
        '<div class="rd-tools"><form class="rd-search scoped-search-bar adult-theme" id="rdForm" data-scoped-search="adult-reading">' +
        '<input id="rdSearch" type="search" autocomplete="off" placeholder="Search ' + esc(sourceName(state.source)) + ' titles, tags, artists..." value="' + esc(state.q) + '">' +
        '<button class="rd-btn gold" type="submit">Search</button></form>' +
        '<span class="rd-adult-badge">Age-gated \u00b7 18+</span></div>' +
        '<div class="rd-chips" id="rdChips"></div>' +
        '<div id="rdBody"></div></div>';
    }
    return '<div class="rd-shell" data-reading-mode="safe">' +
      '<div class="rd-hero"><div>' +
      '<span class="rd-kicker safe">✦ KID-SAFE READING ROOM</span>' +
      '<h1>Reading <em>Room</em></h1>' +
      '<p>Strictly kid-safe manga, manhwa and webcomics delivered through SuperBox Shield with Webtoon, Single Page, and 2-Page Spread reading modes.</p></div>' +
      '<div class="rd-stat"><span>Kid-Safe Only</span><span>Multi-Mode HUD</span><span>Shield Routed</span></div></div>' +
      '<div class="rd-source" role="tablist" aria-label="Reading Sources">' +
      safeSources().map(function (s) {
        return '<button data-rd-source="' + s.id + '" role="tab" aria-selected="' + (state.source === s.id) + '" class="' + (state.source === s.id ? 'on' : '') + '">' + esc(s.name) + '</button>';
      }).join('') +
      '</div>' +
      '<div class="rd-tools"><form class="rd-search scoped-search-bar" id="rdForm" data-scoped-search="reading">' +
      '<input id="rdSearch" type="search" autocomplete="off" placeholder="' + (state.source === 'md'
        ? 'Search manga, manhwa, titles...'
        : state.source === 'wt' ? 'Search WEBTOON series...' : 'Search ' + esc(sourceName(state.source)) + '...') + '" value="' + esc(state.q) + '">' +
      '<button class="rd-btn gold" type="submit">Search</button></form>' +
      '<div class="rd-rating" role="group" aria-label="Age filter">' +
      '<button data-rd-rating="safe" class="' + (state.rating === 'safe' ? 'on' : '') + '">All Ages</button>' +
      '<button data-rd-rating="teen" class="' + (state.rating === 'teen' ? 'on' : '') + '">Teen</button>' +
      '</div></div>' +
      '<div class="rd-filters">' +
      (isNativeSource(state.source)
        ? '<span class="rd-fnote">' + esc(sourceName(state.source)) + ' · native English catalogue</span>'
        : '<label>Language<select id="rdLang" aria-label="Reading language">' + optionHtml(LANGUAGES, state.lang) + '</select></label>' +
          '<label>' + (state.source === 'md' ? 'Type' : 'Format') + '<select id="rdType" aria-label="Title type">' + optionHtml(typesForSource(), state.type) + '</select></label>') +
      '<button type="button" class="rd-btn ghost" id="rdReset">Reset filters</button>' +
      '<span class="rd-fnote">' + (state.source === 'md'
        ? 'Showing kid-safe titles with ' + esc(langLabel(state.lang)) + ' chapters'
        : state.source === 'wt'
          ? 'WEBTOON catalogue: ' + esc(WT_LOCALES[state.lang] ? langLabel(state.lang) : 'English')
          : 'Native in-app reader · zero external redirects') + '</span>' +
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
    return [{ g: '', n: 'All titles' }];
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
    var badge = sourceShort(it.source);
    var native = isNativeSource(it.source);
    var sub = it.source === 'md'
      ? [it.year, it.status, (it.tags || []).slice(0, 2).join(' · ')].filter(Boolean).join(' · ')
      : it.source === 'wt'
        ? (it.genre || it.author || 'WEBTOON')
        : [it.author, (it.tags || []).slice(0, 2).join(' · ')].filter(Boolean).join(' · ');
    var cover = img(it.cover, it.ref || sourceRef(it.source));
    return '<button class="rd-card" type="button" data-rd-open="' + it.source + ':' + esc(it.id) + '">' +
      '<span class="rd-cover"><img loading="lazy" decoding="async" src="' + esc(cover) + '" alt="' + esc(it.title) + '" onerror="this.style.display=\'none\'">' +
      '<span class="rd-badge' + (native ? ' green' : (it.source === 'wt' ? ' green' : '')) + '">' + badge + '</span></span>' +
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
          '<span class="rd-cover"><img loading="lazy" decoding="async" src="' + esc(img(h.cover, h.ref || sourceRef(h.source))) + '" alt="' + esc(h.title) + '" onerror="this.style.display=\'none\'"></span>' +
          '<b>' + esc(h.title) + '</b><span>' + esc(h.chapterLabel || ('Episode ' + (h.ep || ''))) + '</span></button>';
      }).join('') + '</div>';
  }

  function paintBody() {
    var body = root && $('#rdBody', root);
    if (!body) return;
    if (state.view === 'detail') { paintDetail(body); return; }
    var head = historyRow();
    var srcName = sourceName(state.source);
    var native = isNativeSource(state.source);
    if (state.loading && !state.items.length) {
      body.innerHTML = head + '<div class="rd-sec"><h2>' + esc(srcName) + ' catalogue</h2><span class="muted">Loading · ' +
        esc(native ? 'English' : langLabel(state.lang)) + '</span></div><div class="rd-grid">' + skeletonHtml(12) + '</div>';
      return;
    }
    if (!state.items.length) {
      var filtered = !!(state.q || state.genre || state.type || (!native && state.lang !== 'en'));
      body.innerHTML = head + '<div class="rd-empty">' + (state.q
        ? 'Nothing matched that search on ' + esc(srcName) + '.'
        : 'No titles from ' + esc(srcName) + ' for this filter yet.') +
        '<br><span style="font-size:12px;color:#6f7681">Try another source, search or filter.</span>' +
        (filtered ? '<div class="rd-more"><button class="rd-btn" type="button" data-rd-reset="1">Reset filters</button></div>' : '') +
        '</div>';
      return;
    }
    var heading = state.q ? 'Results for “' + esc(state.q) + '”' : (state.source === 'md'
      ? ['Popular on MangaDex', state.type ? typeLabel(state.type) : '', esc(state.genre || ''), state.lang !== 'en' ? langLabel(state.lang) : ''].filter(Boolean).join(' · ')
      : state.source === 'wt'
        ? ['WEBTOON', state.type === 'canvas' ? 'Canvas' : 'Originals', esc(state.genre || ''), WT_LOCALES[state.lang] ? langLabel(state.lang) : 'English'].filter(Boolean).join(' · ')
        : [esc(srcName), state.genre ? esc(state.genre) : (state.adultMode
          ? esc((((providerById(state.source) || {}).tabs || []).filter(function (t) { return t.c === state.tab; })[0] || { n: 'Popular' }).n)
          : 'Popular')].filter(Boolean).join(' · '));
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
      else if (state.adultMode) nativeLoad(true);
      else toast('Use search to narrow this source');
    };
  }

  /* ---------------------------------------------------------------- detail */
  function detailActions() {
    var d = state.detail;
    if (!d) return '';
    var prog = progressOf(d.source, d.id);
    var native = isNativeSource(d.source);
    var label = '';
    if (prog && prog.chapterLabel) {
      if (d.source === 'md' || native) label = 'Continue · ' + prog.chapterLabel;
      else if (d.source === 'wt') label = 'Continue · Episode ' + prog.ep;
    }
    return '<div class="rd-dactions">' +
      (label ? '<button class="rd-btn gold" type="button" data-rd-continue="1">' + esc(label) + '</button>' : '') +
      '<button class="rd-btn" type="button" data-rd-first="1">' + (d.source === 'wt' ? 'Read episode 1' : 'Read first chapter') + '</button>' +
      '</div>';
  }
  function paintDetail(body) {
    var d = state.detail;
    if (!d) { state.view = 'browse'; paintBody(); return; }
    var native = isNativeSource(d.source);
    var chapWord = d.source === 'wt' ? 'Episodes' : 'Chapters';
    var tags = (d.tags || []).map(function (t) { return '<span>' + esc(t) + '</span>'; }).join('');
    body.innerHTML = '<div class="rd-detail"><button class="rd-back" type="button" id="rdBack">← Back to reading</button>' +
      '<div class="rd-dhead"><div class="rd-dcover"><img src="' + esc(img(d.cover, d.ref || sourceRef(d.source))) + '" alt="' + esc(d.title) + '" onerror="this.style.display=\'none\'"></div>' +
      '<div class="rd-dinfo"><h1>' + esc(d.title) + '</h1>' +
      '<p class="by">' + esc(d.author || sourceName(d.source)) + (d.genre ? ' · ' + esc(d.genre) : '') + '</p>' +
      '<div class="rd-dmeta">' + (d.year ? '<span>' + esc(d.year) + '</span>' : '') + (d.status ? '<span>' + esc(d.status) + '</span>' : '') +
      '<span>' + esc(sourceName(d.source)) + '</span></div>' +
      (d.desc ? '<p class="rd-desc">' + esc(d.desc) + '</p>' : '') +
      (tags ? '<div class="rd-dmeta">' + tags + '</div>' : '') +
      detailActions() + '</div></div>' +
      '<div class="rd-chapbar"><h2>' + chapWord + '</h2>' +
      '<input class="rd-chapsearch" id="rdChapSearch" type="search" placeholder="Filter ' + chapWord.toLowerCase() + '..." /></div>' +
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
    } else if (d.source === 'wt') {
      paintChapters('');
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
      var list = (d.chapters || []).filter(function (c) {
        if (!f) return true;
        return ('ch ' + c.chapter + ' ' + c.title + ' ' + c.group).toLowerCase().indexOf(f) >= 0;
      });
      if (!list.length && !f) {
        host.innerHTML = '<div class="rd-empty"><b>No ' + esc(langLabel(d.feedLang || state.lang)) +
          ' chapters</b><span>This title has no readable chapters in the selected language. Pick another language above.</span></div>';
        return;
      }
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
    } else if (isNativeSource(d.source)) {
      var chs = (d.chapters || []).filter(function (c) {
        if (!f) return true;
        return ('ch ' + c.no + ' ' + c.title + ' ' + c.id).toLowerCase().indexOf(f) >= 0;
      });
      if (!chs.length && !f) {
        host.innerHTML = '<div class="rd-empty"><b>No chapters listed</b><span>' + esc(sourceName(d.source)) +
          ' did not return a chapter list for this title. Try another source.</span></div>';
        return;
      }
      host.innerHTML = '<div class="rd-chaps">' + chs.map(function (c) {
        var done = prog && String(prog.chapterId) === String(c.url);
        return '<button class="rd-chap" type="button" data-rd-nat="' + esc(c.url) + '">' +
          '<span class="n">' + esc(c.no < 1e9 ? 'Ch. ' + c.no : 'Ch.') + '</span>' +
          '<span class="t">' + esc(c.title || 'Chapter') + '</span>' +
          '<span class="g">' + esc(sourceShort(d.source)) + ' · EN</span><span class="d"></span>' +
          (done ? '<span class="done">✓</span>' : '') + '</button>';
      }).join('') + '</div>';
    } else {
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
      var nb = e.target.closest('[data-rd-nat]');
      if (nb && isNativeSource(d.source)) {
        var cu = nb.getAttribute('data-rd-nat');
        var chn = (d.chapters || []).filter(function (c) { return String(c.url) === cu; })[0];
        if (chn) openNativeChapter(d, chn);
      }
    };
  }

  function openFirst(d) {
    if (d.source === 'md') {
      if (!d.chapters || !d.chapters.length) { toast('Chapters are still loading'); return; }
      var ch = d.chapters[d.chapters.length - 1];
      openMdChapter(d, ch);
    } else if (isNativeSource(d.source)) {
      if (!d.chapters || !d.chapters.length) { toast('Chapters are still loading'); return; }
      openNativeChapter(d, d.chapters[0]);
    } else {
      var ep = { no: 1, title: 'Episode 1', url: wtSeriesUrlFrom(d.url, 1) };
      openWtChapter(d, ep);
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
    } else if (isNativeSource(d.source)) {
      var nch = (d.chapters || []).filter(function (c) { return String(c.url) === String(p.chapterId); })[0];
      if (nch) { openNativeChapter(d, nch); return; }
      if (d.chapters && d.chapters.length) { openFirst(d); return; }
      nativeDetail(d).then(function (fresh) {
        state.detail = fresh;
        if (state.view === 'detail') paint();
        var hit = (fresh.chapters || []).filter(function (c) { return String(c.url) === String(p.chapterId); })[0];
        openNativeChapter(fresh, hit || (fresh.chapters || [])[0]);
      }).catch(function () { toast('This chapter could not be reopened'); });
    } else {
      var ep = (d.episodes || []).filter(function (e) { return Number(e.no) === Number(p.ep); })[0] ||
        { no: Number(p.ep) || 1, title: 'Episode ' + (p.ep || 1), url: wtSeriesUrlFrom(d.url, p.ep || 1) };
      openWtChapter(d, ep);
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
    } else if (isNativeSource(source)) {
      state.detail = {
        source: source, id: h.id, title: h.title, cover: h.cover, desc: h.desc || '',
        tags: h.tags || [], url: h.seriesUrl || '', ref: h.ref || sourceRef(source),
        chapters: [], more: false, chapterMode: 'native'
      };
    } else {
      state.detail = {
        source: 'wt', id: h.id, title: h.title, cover: h.cover, desc: h.desc || '',
        tags: [], url: h.seriesUrl, episodes: [], more: false, page: 1
      };
    }
    state.view = 'detail';
    paint();
    if (source === 'wt' && h.seriesUrl) {
      wtSeries(h.seriesUrl).then(function (s) {
        s.id = h.id;
        state.detail = s;
        if (state.view === 'detail') paint();
      }).catch(function () {});
    } else if (isNativeSource(source) && h.seriesUrl) {
      nativeDetail({ source: source, id: h.id, title: h.title, cover: h.cover, url: h.seriesUrl, ref: h.ref || sourceRef(source) })
        .then(function (fresh) {
          state.detail = fresh;
          if (state.view === 'detail') paint();
          var ch = (fresh.chapters || []).filter(function (c) { return String(c.url) === String(h.chapterId); })[0];
          if (ch) openNativeChapter(fresh, ch);
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
  var readerCtx = { urls: [], ref: '', page: 0, hudTimer: 0, prev: null, next: null, keyHandler: null };

  function buildSpreadPairs(total) {
    var pairs = [];
    if (!total || total <= 0) return pairs;
    pairs.push([0]);
    for (var i = 1; i < total; i += 2) {
      if (i + 1 < total) pairs.push([i, i + 1]);
      else pairs.push([i]);
    }
    return pairs;
  }

  function showReaderHud(autoHide) {
    if (!readerEl) return;
    readerEl.classList.remove('hud-hidden');
    clearTimeout(readerCtx.hudTimer);
    if (autoHide !== false) {
      readerCtx.hudTimer = setTimeout(function () {
        if (!readerEl) return;
        var drawer = $('#rdChapDrawer', readerEl);
        if (drawer && drawer.classList.contains('open')) return;
        readerEl.classList.add('hud-hidden');
      }, 3600);
    }
  }
  function toggleReaderHud() {
    if (!readerEl) return;
    if (readerEl.classList.contains('hud-hidden')) showReaderHud(true);
    else {
      clearTimeout(readerCtx.hudTimer);
      readerEl.classList.add('hud-hidden');
    }
  }

  function chapterListForDrawer() {
    var d = state.detail;
    if (!d) return [];
    if (d.source === 'md') {
      return (d.chapters || []).map(function (c) {
        return { id: c.id, label: (c.chapter ? 'Ch. ' + c.chapter : 'Oneshot') + (c.title ? ' · ' + c.title : ''), active: c.id === readerKey, open: function () { openMdChapter(d, c); } };
      });
    }
    if (d.source === 'wt') {
      return (d.episodes || []).map(function (e) {
        return { id: 'ep' + e.no, label: 'Episode ' + e.no + (e.title ? ' · ' + e.title : ''), active: ('ep' + e.no) === readerKey, open: function () { openWtChapter(d, e); } };
      });
    }
    return (d.chapters || []).map(function (c) {
      return { id: c.url, label: c.title || ('Ch. ' + c.no), active: String(c.url) === String(readerKey), open: function () { openNativeChapter(d, c); } };
    });
  }

  function paintDrawerChapters(filter) {
    if (!readerEl) return;
    var listEl = $('#rdChapDrawerList', readerEl);
    if (!listEl) return;
    var q = String(filter || '').toLowerCase();
    var chs = chapterListForDrawer().filter(function (c) {
      return !q || c.label.toLowerCase().indexOf(q) >= 0;
    });
    if (!chs.length) {
      listEl.innerHTML = '<div class="rd-loading">No matching chapters</div>';
      return;
    }
    listEl.innerHTML = chs.slice(0, 300).map(function (c, i) {
      return '<button type="button" class="rd-cdrawer-item' + (c.active ? ' on' : '') + '" data-rd-dch="' + i + '">' +
        '<span>' + esc(c.label) + '</span>' + (c.active ? '<span>●</span>' : '') + '</button>';
    }).join('');
    listEl.onclick = function (e) {
      var b = e.target.closest('[data-rd-dch]');
      if (!b) return;
      var item = chs[Number(b.getAttribute('data-rd-dch')) || 0];
      if (item && item.open) {
        closeChapterDrawer();
        item.open();
      }
    };
  }
  function openChapterDrawer() {
    if (!readerEl) return;
    clearTimeout(readerCtx.hudTimer);
    readerEl.classList.remove('hud-hidden');
    var bg = $('#rdChapDrawerBg', readerEl);
    var dr = $('#rdChapDrawer', readerEl);
    if (bg) bg.classList.add('open');
    if (dr) dr.classList.add('open');
    paintDrawerChapters($('#rdChapDrawerSearch', readerEl) ? $('#rdChapDrawerSearch', readerEl).value : '');
  }
  function closeChapterDrawer() {
    if (!readerEl) return;
    var bg = $('#rdChapDrawerBg', readerEl);
    var dr = $('#rdChapDrawer', readerEl);
    if (bg) bg.classList.remove('open');
    if (dr) dr.classList.remove('open');
  }

  function syncToolbarUi() {
    if (!readerEl) return;
    $$('[data-rd-mode]', readerEl).forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-rd-mode') === readerPrefs.mode);
    });
    $$('[data-rd-fit]', readerEl).forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-rd-fit') === readerPrefs.fit);
    });
    var zVal = $('#rdZoomVal', readerEl);
    if (zVal) zVal.textContent = readerPrefs.zoom + '%';
    var sliderRow = $('#rdSliderRow', readerEl);
    if (sliderRow) sliderRow.style.display = readerPrefs.mode === 'webtoon' ? 'none' : 'flex';
  }

  function readerShell(title, sub, prev, next, pages) {
    closeReader();
    style();
    readerCtx.prev = prev || null;
    readerCtx.next = next || null;
    readerCtx.urls = [];
    readerCtx.page = 0;
    readerEl = document.createElement('div');
    readerEl.className = 'rd-reader';
    readerEl.setAttribute('data-reader-hud', '1');
    readerEl.innerHTML = '<div class="rd-rbar" id="rdRTop">' +
      '<button type="button" id="rdRBack" aria-label="Back">←</button>' +
      '<div class="rd-rtitle"><b>' + esc(title) + '</b><span>' + esc(sub) + '</span></div>' +
      '<div class="rd-rpages" id="rdRPages">' + esc(pages || '') + '</div>' +
      '<button type="button" id="rdRChapBtn" aria-label="Chapters">☰</button>' +
      '<button type="button" id="rdRPrev"' + (prev ? '' : ' disabled') + ' aria-label="Previous chapter">‹</button>' +
      '<button type="button" id="rdRNext"' + (next ? '' : ' disabled') + ' aria-label="Next chapter">›</button>' +
      '</div>' +
      '<div class="rd-rbody" id="rdRBody"><div class="rd-loading" style="padding-top:88px"><span class="rd-spin"></span>Loading pages</div></div>' +
      '<div class="rd-toolbar" id="rdToolbar" role="toolbar" aria-label="Reader controls">' +
      '<div class="rd-slider-row" id="rdSliderRow" style="display:none">' +
      '<span id="rdPageNum">1 / 1</span>' +
      '<input id="rdPageSlider" type="range" min="0" max="0" value="0" aria-label="Page">' +
      '</div>' +
      '<div class="rd-tb-row">' +
      '<div class="rd-seg" role="group" aria-label="Reading mode">' +
      '<button type="button" data-rd-mode="webtoon">Webtoon</button>' +
      '<button type="button" data-rd-mode="single">Single</button>' +
      '<button type="button" data-rd-mode="spread">2-Page</button>' +
      '</div>' +
      '<div class="rd-seg" role="group" aria-label="Fit mode">' +
      '<button type="button" data-rd-fit="width">Fit W</button>' +
      '<button type="button" data-rd-fit="height">Fit H</button>' +
      '</div>' +
      '<div class="rd-zoom-box">' +
      '<button type="button" id="rdZoomOut" aria-label="Zoom out">−</button>' +
      '<span id="rdZoomVal">' + readerPrefs.zoom + '%</span>' +
      '<button type="button" id="rdZoomIn" aria-label="Zoom in">+</button>' +
      '</div>' +
      '</div></div>' +
      '<div class="rd-cdrawer-bg" id="rdChapDrawerBg"></div>' +
      '<aside class="rd-cdrawer" id="rdChapDrawer" aria-label="Chapter drawer">' +
      '<div class="rd-cdrawer-head"><b>Chapters</b><button type="button" id="rdChapDrawerClose" aria-label="Close">×</button></div>' +
      '<input type="search" class="rd-cdrawer-search" id="rdChapDrawerSearch" placeholder="Jump to chapter…" />' +
      '<div class="rd-cdrawer-list" id="rdChapDrawerList"></div></aside>' +
      '<div class="rd-rprog"><i id="rdRProg"></i></div>';
    document.body.appendChild(readerEl);
    document.body.classList.add('rd-lock');
    $('#rdRBack', readerEl).onclick = closeReader;
    if (prev) $('#rdRPrev', readerEl).onclick = prev.run;
    if (next) $('#rdRNext', readerEl).onclick = next.run;
    $('#rdRChapBtn', readerEl).onclick = openChapterDrawer;
    $('#rdChapDrawerBg', readerEl).onclick = closeChapterDrawer;
    $('#rdChapDrawerClose', readerEl).onclick = closeChapterDrawer;
    var dSearch = $('#rdChapDrawerSearch', readerEl);
    if (dSearch) dSearch.oninput = function () { paintDrawerChapters(dSearch.value); };
    $$('[data-rd-mode]', readerEl).forEach(function (b) {
      b.onclick = function () {
        readerPrefs.mode = b.getAttribute('data-rd-mode') || 'webtoon';
        saveReaderPrefs();
        syncToolbarUi();
        renderReaderViewport();
        showReaderHud(true);
      };
    });
    $$('[data-rd-fit]', readerEl).forEach(function (b) {
      b.onclick = function () {
        readerPrefs.fit = b.getAttribute('data-rd-fit') === 'height' ? 'height' : 'width';
        saveReaderPrefs();
        syncToolbarUi();
        renderReaderViewport();
        showReaderHud(true);
      };
    });
    $('#rdZoomOut', readerEl).onclick = function () {
      readerPrefs.zoom = Math.max(60, readerPrefs.zoom - 15);
      saveReaderPrefs();
      syncToolbarUi();
      applyReaderZoom();
      showReaderHud(true);
    };
    $('#rdZoomIn', readerEl).onclick = function () {
      readerPrefs.zoom = Math.min(200, readerPrefs.zoom + 15);
      saveReaderPrefs();
      syncToolbarUi();
      applyReaderZoom();
      showReaderHud(true);
    };
    var slider = $('#rdPageSlider', readerEl);
    if (slider) {
      slider.oninput = function () {
        readerCtx.page = Number(slider.value) || 0;
        renderReaderViewport();
        showReaderHud(true);
      };
    }
    var swipeBody = $('#rdRBody', readerEl);
    if (swipeBody) {
      var swX = 0, swY = 0, swT = 0;
      swipeBody.addEventListener('touchstart', function (ev) {
        if (ev.touches.length !== 1) return;
        swX = ev.touches[0].clientX; swY = ev.touches[0].clientY; swT = Date.now();
      }, { passive: true });
      swipeBody.addEventListener('touchend', function (ev) {
        if (readerPrefs.mode === 'webtoon' || !ev.changedTouches.length) return;
        var dx = ev.changedTouches[0].clientX - swX;
        var dy = ev.changedTouches[0].clientY - swY;
        if (Date.now() - swT > 800 || Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
        stepReaderPage(dx < 0 ? 1 : -1);
      }, { passive: true });
    }
    readerCtx.keyHandler = function (ev) {
      if (!readerEl) return;
      if (ev.key === 'Escape') {
        var dr = $('#rdChapDrawer', readerEl);
        if (dr && dr.classList.contains('open')) closeChapterDrawer();
        else closeReader();
      } else if (readerPrefs.mode !== 'webtoon' && (ev.key === 'ArrowRight' || ev.key === ' ')) {
        ev.preventDefault();
        stepReaderPage(1);
      } else if (readerPrefs.mode !== 'webtoon' && ev.key === 'ArrowLeft') {
        ev.preventDefault();
        stepReaderPage(-1);
      }
    };
    document.addEventListener('keydown', readerCtx.keyHandler);
    syncToolbarUi();
    showReaderHud(true);
    return readerEl;
  }
  function closeReader() {
    if (!readerEl) return false;
    clearTimeout(readerCtx.hudTimer);
    if (readerCtx.keyHandler) {
      document.removeEventListener('keydown', readerCtx.keyHandler);
      readerCtx.keyHandler = null;
    }
    try { readerEl.remove(); } catch (e) {}
    readerEl = null;
    document.body.classList.remove('rd-lock');
    if (state.view === 'detail') paint();
    return true;
  }
  function applyReaderZoom() {
    if (!readerEl) return;
    var strip = $('.rd-strip', readerEl);
    if (strip) strip.style.maxWidth = Math.round(860 * (readerPrefs.zoom / 100)) + 'px';
    var wrap = $('.rd-page-wrap', readerEl);
    if (wrap) wrap.style.transform = readerPrefs.zoom === 100 ? '' : 'scale(' + (readerPrefs.zoom / 100) + ')';
  }
  function stepReaderPage(delta) {
    var urls = readerCtx.urls || [];
    if (!urls.length) return;
    if (readerPrefs.mode === 'spread') {
      var pairs = buildSpreadPairs(urls.length);
      var nextIdx = readerCtx.page + delta;
      if (nextIdx < 0) { if (readerCtx.prev) readerCtx.prev.run(); return; }
      if (nextIdx >= pairs.length) { if (readerCtx.next) readerCtx.next.run(); else toast('End of chapter'); return; }
      readerCtx.page = nextIdx;
    } else {
      var nextP = readerCtx.page + delta;
      if (nextP < 0) { if (readerCtx.prev) readerCtx.prev.run(); return; }
      if (nextP >= urls.length) { if (readerCtx.next) readerCtx.next.run(); else toast('End of chapter'); return; }
      readerCtx.page = nextP;
    }
    renderReaderViewport();
  }
  function bindReaderScroll(key) {
    var body = $('#rdRBody', readerEl);
    var bar = $('#rdRProg', readerEl);
    if (!body) return;
    var saved = lsGet(readPosKey(state.detail && state.detail.source, key), null);
    var ticking = false;
    var lastY = 0;
    body.onscroll = function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        ticking = false;
        var y = body.scrollTop;
        if (y > lastY + 18 && y > 80 && readerEl) readerEl.classList.add('hud-hidden');
        lastY = y;
        var max = Math.max(1, body.scrollHeight - body.clientHeight);
        if (bar) bar.style.width = Math.min(100, (y / max) * 100) + '%';
        clearTimeout(scrollSaveTimer);
        scrollSaveTimer = setTimeout(function () {
          lsSet(readPosKey(state.detail && state.detail.source, key), { y: y, at: Date.now() });
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
  function renderReaderViewport() {
    if (!readerEl) return;
    var body = $('#rdRBody', readerEl);
    var urls = readerCtx.urls || [];
    var ref = readerCtx.ref || '';
    if (!body || !urls.length) return;
    var bar = $('#rdRProg', readerEl);
    var pagesLbl = $('#rdRPages', readerEl);
    var pageNum = $('#rdPageNum', readerEl);
    var slider = $('#rdPageSlider', readerEl);
    body.className = 'rd-rbody mode-' + readerPrefs.mode;

    if (readerPrefs.mode === 'webtoon') {
      body.innerHTML = '<div class="rd-strip fit-' + readerPrefs.fit + '">' + urls.map(function (u, i) {
        return '<img loading="' + (i < 2 ? 'eager' : 'lazy') + '" decoding="async" src="' + esc(img(u, ref)) +
          '" alt="Page ' + (i + 1) + '" data-pg="' + (i + 1) + '" onerror="this.classList.add(\'rd-fail\');this.alt=\'Page ' + (i + 1) + ' failed to load\'">';
      }).join('') + '</div><div class="rd-rend" id="rdREnd">' +
        '<div>End of chapter</div>' +
        (readerCtx.prev ? '<button class="rd-btn" type="button" id="rdEndPrev">‹ Prev chapter</button>' : '') +
        (readerCtx.next ? '<button class="rd-btn gold" type="button" id="rdEndNext">Next chapter ›</button>' : '') +
        '</div>';
      $$('img[data-pg]', body).forEach(function (im) { im.classList.add('rd-on'); });
      if ($('#rdEndPrev', body) && readerCtx.prev) $('#rdEndPrev', body).onclick = readerCtx.prev.run;
      if ($('#rdEndNext', body) && readerCtx.next) $('#rdEndNext', body).onclick = readerCtx.next.run;
      body.onclick = function (ev) {
        if (ev.target.closest('button')) return;
        toggleReaderHud();
      };
      if (pagesLbl) pagesLbl.textContent = urls.length + ' pages';
      applyReaderZoom();
      bindReaderScroll(readerKey);
      return;
    }

    var isSpread = readerPrefs.mode === 'spread';
    var pairs = isSpread ? buildSpreadPairs(urls.length) : urls.map(function (_, i) { return [i]; });
    if (readerCtx.page >= pairs.length) readerCtx.page = Math.max(0, pairs.length - 1);
    if (readerCtx.page < 0) readerCtx.page = 0;
    var pair = pairs[readerCtx.page] || [0];
    var imgsHtml = pair.map(function (idx) {
      return '<img decoding="async" src="' + esc(img(urls[idx], ref)) + '" alt="Page ' + (idx + 1) + '" onerror="this.classList.add(\'rd-fail\')">';
    }).join('');
    body.innerHTML = '<button type="button" class="rd-tap-prev" id="rdTapPrev" aria-label="Previous page"></button>' +
      '<button type="button" class="rd-tap-next" id="rdTapNext" aria-label="Next page"></button>' +
      '<div class="rd-stage fit-' + readerPrefs.fit + (isSpread ? ' spread-mode' : '') + '">' +
      '<div class="rd-page-wrap">' + imgsHtml + '</div></div>';
    $('#rdTapPrev', body).onclick = function () { stepReaderPage(-1); };
    $('#rdTapNext', body).onclick = function () { stepReaderPage(1); };
    $('.rd-stage', body).onclick = function (ev) {
      if (ev.target.closest('button')) return;
      toggleReaderHud();
    };
    var disp = pair.length === 2 ? (pair[0] + 1) + '–' + (pair[1] + 1) + ' / ' + urls.length : (pair[0] + 1) + ' / ' + urls.length;
    if (pagesLbl) pagesLbl.textContent = disp;
    if (pageNum) pageNum.textContent = disp;
    if (slider) {
      slider.max = String(Math.max(0, pairs.length - 1));
      slider.value = String(readerCtx.page);
    }
    if (bar) bar.style.width = (((readerCtx.page + 1) / Math.max(1, pairs.length)) * 100) + '%';
    applyReaderZoom();
    // Prefetch next spread/page
    var nextPair = pairs[readerCtx.page + 1];
    if (nextPair) nextPair.forEach(function (idx) { try { new Image().src = img(urls[idx], ref); } catch (e) {} });
  }
  function readerImages(urls, ref) {
    readerCtx.urls = urls || [];
    readerCtx.ref = ref || '';
    readerCtx.page = 0;
    for (var i = 0; i < Math.min(readerCtx.urls.length, 4); i++) {
      try { new Image().src = img(readerCtx.urls[i], ref); } catch (e) {}
    }
    syncToolbarUi();
    renderReaderViewport();
  }
  function openChapterPages(title, sub, urls, opts) {
    opts = opts || {};
    readerKey = opts.key || ('custom:' + Date.now());
    readerShell(title || 'Reader', sub || '', opts.prev || null, opts.next || null, (urls || []).length + ' pages');
    readerImages(urls || [], opts.ref || '');
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
      if (body) body.innerHTML = '<div class="rd-empty" style="margin:60px auto;max-width:520px">This chapter could not be loaded. Try again in a moment.<br><br>' +
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
      if (body) body.innerHTML = '<div class="rd-empty" style="margin:60px auto;max-width:520px">This episode could not be loaded. Try again in a moment.<br><br>' +
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
    } else if (isNativeSource(item.source)) {
      try {
        var nd = await nativeDetail(item);
        state.detail = nd;
        if (state.view === 'detail') paint();
      } catch (e) {
        if (state.view === 'detail') paint();
        toast((e && e.message) || (sourceName(item.source) + ' could not be opened'));
      }
    } else {
      try {
        var s = await wtSeries(item.url);
        s.id = item.id || s.id;
        state.detail = s;
        if (state.view === 'detail') paint();
      } catch (e) {}
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
    function reload() {
      if (state.source === 'md') mdLoad(false);
      else if (state.source === 'wt') wtLoad();
      else nativeLoad(false);
    }
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
        if (state.adultMode) return;
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
  window.READER = {
    render: function (host, opts) {
      root = host || root;
      var wantAdult = !!(opts && opts.adult);
      var modeChanged = wantAdult !== state.adultMode;
      state.adultMode = wantAdult;
      if (modeChanged) { state.items = []; state.q = ''; state.genre = ''; }
      if (wantAdult) {
        var wantSrc = opts && opts.source && isAdultProviderId(opts.source)
          ? opts.source : (isAdultProviderId(state.source) ? state.source : 'hentai20');
        state.source = wantSrc;
        state.lang = 'en';
        state.rating = 'mature';
        state.page = 1;
        var np = providerById(state.source);
        state.tab = np && np.tabs && np.tabs.length ? np.tabs[0].c : '';
        if (opts && opts.query) state.q = opts.query;
      } else {
        if (state.rating === 'mature') state.rating = 'teen';
        if (isAdultProviderId(state.source)) { state.source = 'md'; state.items = []; }
      }
      state.view = 'browse';
      state.detail = null;
      style();
      /* Resolve the bridge origin before painting so every cover uses the
         cached /img route instead of a raw origin URL. */
      base().then(function () {
        if (!root) return;
        paint();
        mdTags().then(function () {
          if (root && !state.adultMode && state.source === 'md' && state.view === 'browse') paintChips();
        });
        if (!state.items.length) {
          if (state.source === 'md') mdLoad(false);
          else if (state.source === 'wt') wtLoad();
          else nativeLoad(false);
        }
      });
    },
    renderAdult: function (host, opts) {
      opts = opts || {};
      root = host || root;
      state.adultMode = true;
      var wantSrc = opts.source && isAdultProviderId(opts.source) ? opts.source : (isAdultProviderId(state.source) ? state.source : 'hentai20');
      if (state.source !== wantSrc) {
        state.source = wantSrc;
        state.items = [];
      }
      state.q = opts.q || '';
      state.genre = '';
      state.view = 'browse';
      state.detail = null;
      style();
      base().then(function () {
        if (!root) return;
        paint();
        nativeLoad(false);
      });
    },
    registerAdultAdapter: registerAdultAdapter,
    openChapterPages: openChapterPages,
    buildSpreadPairs: buildSpreadPairs,
    safeSources: safeSources,
    adultSources: adultSources,
    setReaderPrefs: function (next) {
      if (!next) return;
      if (['webtoon', 'single', 'spread'].indexOf(next.mode) >= 0) readerPrefs.mode = next.mode;
      if (next.fit === 'width' || next.fit === 'height') readerPrefs.fit = next.fit;
      if (isFinite(Number(next.zoom))) readerPrefs.zoom = Math.max(60, Math.min(200, Number(next.zoom)));
      saveReaderPrefs();
      syncToolbarUi();
      if (readerEl) renderReaderViewport();
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
    version: '2.0.0'
  };
})();
