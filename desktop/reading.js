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
  async function page(url, ms) {
    var B = await base();
    var r = await withTimeout(fetch(B + '/page?url=' + enc(url), { cache: 'no-store' }), ms || 26000);
    if (!r.ok) throw new Error('proxy HTTP ' + r.status);
    var body = await withTimeout(r.text(), ms || 26000);
    if (!body || body.indexOf('PROXY_ERROR') === 0 || body.length < 2) {
      throw new Error('source unavailable');
    }
    return body;
  }
  async function api(url, ms) {
    var body = await page(url, ms);
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
  function openSite(url, title) {
    if (!url) return;
    if (window.SBAndroid && window.SBAndroid.openWeb) {
      try { window.SBAndroid.openWeb(url, title || 'SuperBox'); return; } catch (e) {}
    }
    if (typeof window.SBOpenWeb === 'function') {
      try { window.SBOpenWeb(url, title || 'SuperBox'); return; } catch (e) {}
    }
    if (window.bridge && window.bridge.openExternal) {
      try { window.bridge.openExternal(url); return; } catch (e) {}
    }
    try { window.open(url, '_blank', 'noopener'); } catch (e) {}
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
    if (cache && cache.v && cache.t && Date.now() - cache.t < 7 * 86400000) {
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
  var state = {
    source: 'md',
    q: '',
    genre: '',
    rating: 'teen',
    offset: 0,
    items: [],
    total: 0,
    loading: false,
    more: false,
    view: 'browse',
    detail: null,
    wtPage: 1
  };

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
      rating: a.contentRating || ''
    };
  }
  async function mdLoad(append) {
    if (!append) { state.offset = 0; state.items = []; }
    state.loading = true;
    state.more = false;
    paintBody();
    var tagId = '';
    if (state.genre) {
      var tags = await mdTags();
      var hit = tags.filter(function (t) { return t.n.toLowerCase() === state.genre.toLowerCase(); })[0];
      tagId = hit ? hit.id : '';
    }
    var pairs = [
      ['limit', '24'],
      ['offset', String(state.offset)],
      ['includes[]', 'cover_art'],
      ['includes[]', 'author'],
      ['hasAvailableChapters', 'true'],
      ['availableTranslatedLanguage[]', 'en']
    ];
    if (state.q) { pairs.push(['title', state.q]); pairs.push(['order[relevance]', 'desc']); }
    else pairs.push(['order[followedCount]', 'desc']);
    if (tagId) pairs.push(['includedTags[]', tagId]);
    ratingPairs().forEach(function (r) { pairs.push(['contentRating[]', r]); });
    try {
      var j = null;
      /* MangaDex rate-limits bursts; one quiet retry keeps the shelf full. */
      for (var attempt = 0; attempt < 2; attempt++) {
        try {
          j = await api('https://api.mangadex.org/manga?' + qs(pairs));
          break;
        } catch (err) {
          if (attempt === 1) throw err;
          await new Promise(function (r) { setTimeout(r, 1400); });
        }
      }
      var list = (j.data || []).map(mdCard).filter(ratingAllowed);
      state.items = append ? state.items.concat(list) : list;
      state.offset += (j.data || []).length;
      state.total = Number(j.total) || state.items.length;
      state.more = state.offset < state.total && (j.data || []).length > 0;
    } catch (e) {
      if (!append) state.items = [];
      toast(e.message || 'MangaDex is unavailable');
    }
    state.loading = false;
    paintBody();
    if (!append) {
      mdCoverBase().then(function () {
        if (state.source === 'md' && state.view === 'browse' && root) paintBody();
      });
    }
  }

  function mdFeed(manga, offset, append) {
    function feed(lang) {
      var pairs = [
        ['limit', '500'],
        ['offset', String(offset || 0)],
        ['order[chapter]', 'desc'],
        ['includes[]', 'scanlation_group']
      ];
      if (lang) pairs.splice(2, 0, ['translatedLanguage[]', lang]);
      return api('https://api.mangadex.org/manga/' + manga.id + '/feed?' + qs(pairs));
    }
    function mapAll(j) {
      return (j.data || []).map(function (c) {
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
          lang: a.translatedLanguage || 'en',
          date: a.publishAt || '',
          group: group
        };
      });
    }
    function readable(j) {
      return mapAll(j).filter(function (c) { return c.pages > 0; });
    }
    /* English first. A title whose EN releases are all official links
       (externalUrl, pages 0) must fall back to every language, and finally
       to the unfiltered list, otherwise its detail page shows a blank
       chapter box even though MangaDex returned chapters. */
    return feed('en').then(function (j) {
      var list = readable(j);
      if (!append && !offset && !list.length) {
        return feed('').then(function (j2) {
          var l2 = readable(j2);
          return { j: j2, list: l2.length ? l2 : mapAll(j2) };
        });
      }
      return { j: j, list: list };
    }).then(function (r) {
      var j = r.j;
      var list = r.list;
      if (append) manga.chapters = (manga.chapters || []).concat(list);
      else manga.chapters = list;
      manga.feedOffset = (offset || 0) + (j.data || []).length;
      manga.feedTotal = Number(j.total) || manga.chapters.length;
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
    if (state.q) return 'https://www.webtoons.com/en/search?keyword=' + enc(state.q);
    if (state.genre) return 'https://www.webtoons.com/en/genres/' + state.genre + '?sortOrder=UPDATE';
    return 'https://www.webtoons.com/en/originals?sortOrder=UPDATE';
  }
  async function wtLoad() {
    state.loading = true;
    state.more = false;
    paintBody();
    try {
      var html = await page(wtBrowseUrl(), 28000);
      var list = parseWtCards(html).filter(ratingAllowed).slice(0, 30);
      state.items = list;
      state.total = list.length;
      state.more = false;
    } catch (e) {
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
      '.rd-tools{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:0 0 14px}',
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
      '@media(max-width:720px){.rd-shell{padding:14px 13px 92px}.rd-hero{gap:10px;margin-bottom:14px}.rd-hero p{font-size:12.5px}.rd-grid{grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px}.rd-cover{border-radius:10px}.rd-card b{font-size:12px}.rd-card span{font-size:10.5px}.rd-source{width:100%}.rd-source button{flex:1;padding:9px 8px;font-size:12px}.rd-chips{margin-bottom:16px;flex-wrap:nowrap;overflow-x:auto;padding-bottom:4px}.rd-detail{padding:2px 0 20px}.rd-dcover{flex:0 0 128px;max-width:128px}.rd-dinfo h1{font-size:25px}.rd-desc{max-height:120px}.rd-chap .g{display:none}.rd-chap .d{flex-basis:70px}.rd-chap .n{flex-basis:62px}.rd-rpages{display:none}.rd-rtitle b{font-size:12.5px}.rd-rbar{gap:7px;padding-left:9px;padding-right:9px}.rd-rbar button{min-width:34px;height:34px;padding:0 9px;font-size:15px}}'
    ].join('\n');
    document.head.appendChild(s);
  }

  /* ----------------------------------------------------------------- paint */
  function shellHtml() {
    return '<div class="rd-shell">' +
      '<div class="rd-hero"><div><h1>Reading <em>room</em></h1>' +
      '<p>Manga, manhwa and webcomics from MangaDex and WEBTOON, delivered through the Shield tunnel. Every page is cached, nothing is tracked.</p></div>' +
      '<div class="rd-stat"><span>MangaDex API</span><span>WEBTOON</span><span>VPN routed</span><span>Offline cache</span></div></div>' +
      '<div class="rd-source" role="tablist">' +
      '<button data-rd-source="md" role="tab" aria-selected="' + (state.source === 'md') + '" class="' + (state.source === 'md' ? 'on' : '') + '">MangaDex</button>' +
      '<button data-rd-source="wt" role="tab" aria-selected="' + (state.source === 'wt') + '" class="' + (state.source === 'wt' ? 'on' : '') + '">WEBTOON</button>' +
      '</div>' +
      '<div class="rd-tools"><form class="rd-search" id="rdForm">' +
      '<input id="rdSearch" type="search" autocomplete="off" placeholder="' + (state.source === 'md' ? 'Search manga, manhwa, titles...' : 'Search WEBTOON series...') + '" value="' + esc(state.q) + '">' +
      '<button class="rd-btn gold" type="submit">Search</button></form>' +
      '<div class="rd-rating" role="group" aria-label="Age rating">' +
      '<button data-rd-rating="safe" class="' + (state.rating === 'safe' ? 'on' : '') + '">All ages</button>' +
      '<button data-rd-rating="teen" class="' + (state.rating === 'teen' ? 'on' : '') + '">Teen</button>' +
      '<button data-rd-rating="mature" class="' + (state.rating === 'mature' ? 'on' : '') + '">18+</button>' +
      '</div></div>' +
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
    return [{ g: '', n: 'All genres' }].concat(WT_GENRES.map(function (g) { return { g: g.s, n: g.n }; }));
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
    var badge = it.source === 'md' ? 'MD' : (it.adult ? '18+' : 'WT');
    var sub = it.source === 'md' ? [it.year, it.status, (it.tags || []).slice(0, 2).join(' · ')].filter(Boolean).join(' · ') : (it.genre || it.author || 'WEBTOON');
    return '<button class="rd-card" type="button" data-rd-open="' + it.source + ':' + esc(it.id) + '">' +
      '<span class="rd-cover"><img loading="lazy" decoding="async" src="' + esc(img(it.cover)) + '" alt="' + esc(it.title) + '" onerror="this.style.display=\'none\'">' +
      '<span class="rd-badge' + (it.source === 'wt' ? ' green' : '') + '">' + badge + '</span></span>' +
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
    var head = historyRow();
    if (state.loading && !state.items.length) {
      body.innerHTML = head + '<div class="rd-sec"><h2>' + (state.source === 'md' ? 'MangaDex catalogue' : 'WEBTOON originals') + '</h2><span class="muted">Loading</span></div><div class="rd-grid">' + skeletonHtml(12) + '</div>';
      return;
    }
    if (!state.items.length) {
      body.innerHTML = head + '<div class="rd-empty">' + (state.q ? 'Nothing matched that search.' : 'No titles available right now.') + '<br><span style="font-size:12px;color:#6f7681">Try another genre or refresh the section.</span></div>';
      return;
    }
    body.innerHTML = head +
      '<div class="rd-sec"><h2>' + (state.q ? 'Results for “' + esc(state.q) + '”' : (state.source === 'md' ? 'Popular on MangaDex' : (state.genre ? 'WEBTOON · ' + esc(state.genre) : 'WEBTOON originals'))) + '</h2>' +
      '<span class="muted">' + (state.total ? state.total + ' titles' : state.items.length + ' titles') + '</span></div>' +
      '<div class="rd-grid">' + state.items.map(cardHtml).join('') + '</div>' +
      (state.loading ? '<div class="rd-loading"><span class="rd-spin"></span>Loading more</div>' : '') +
      (state.more ? '<div class="rd-more"><button class="rd-btn" type="button" id="rdMore">Load more</button></div>' : '');
    var more = $('#rdMore', body);
    if (more) more.onclick = function () {
      if (state.loading) return;
      if (state.source === 'md') mdLoad(true);
      else toast('Open a genre on WEBTOON for the full list');
    };
  }

  /* ---------------------------------------------------------------- detail */
  function detailActions() {
    var d = state.detail;
    if (!d) return '';
    var prog = progressOf(d.source, d.id);
    var label = '';
    if (prog && prog.chapterLabel && d.source === 'md') label = 'Continue · ' + prog.chapterLabel;
    if (prog && prog.ep && d.source === 'wt') label = 'Continue · Episode ' + prog.ep;
    return '<div class="rd-dactions">' +
      (label ? '<button class="rd-btn gold" type="button" data-rd-continue="1">' + esc(label) + '</button>' : '') +
      '<button class="rd-btn" type="button" data-rd-first="1">' + (d.source === 'md' ? 'Read first chapter' : 'Read episode 1') + '</button>' +
      '<button class="rd-btn ghost" type="button" data-rd-site="1">Open on ' + (d.source === 'md' ? 'MangaDex' : 'WEBTOON') + '</button>' +
      '</div>';
  }
  function paintDetail(body) {
    var d = state.detail;
    if (!d) { state.view = 'browse'; paintBody(); return; }
    var tags = (d.tags || []).map(function (t) { return '<span>' + esc(t) + '</span>'; }).join('');
    body.innerHTML = '<div class="rd-detail"><button class="rd-back" type="button" id="rdBack">← Back to reading</button>' +
      '<div class="rd-dhead"><div class="rd-dcover"><img src="' + esc(img(d.cover)) + '" alt="' + esc(d.title) + '" onerror="this.style.display=\'none\'"></div>' +
      '<div class="rd-dinfo"><h1>' + esc(d.title) + '</h1>' +
      '<p class="by">' + esc(d.author || (d.source === 'md' ? 'MangaDex' : 'WEBTOON')) + (d.genre ? ' · ' + esc(d.genre) : '') + '</p>' +
      '<div class="rd-dmeta">' + (d.year ? '<span>' + esc(d.year) + '</span>' : '') + (d.status ? '<span>' + esc(d.status) + '</span>' : '') +
      (d.source === 'md' ? '<span>MangaDex</span>' : '<span>WEBTOON</span>') + '</div>' +
      (d.desc ? '<p class="rd-desc">' + esc(d.desc) + '</p>' : '') +
      (tags ? '<div class="rd-dmeta">' + tags + '</div>' : '') +
      detailActions() + '</div></div>' +
      '<div class="rd-chapbar"><h2>' + (d.source === 'md' ? 'Chapters' : 'Episodes') + '</h2>' +
      '<input class="rd-chapsearch" id="rdChapSearch" type="search" placeholder="Filter ' + (d.source === 'md' ? 'chapters' : 'episodes') + '..." /></div>' +
      '<div id="rdChapList"></div></div>';
    var back = $('#rdBack', body);
    if (back) back.onclick = function () { state.view = 'browse'; state.detail = null; paint(); };
    var site = $('[data-rd-site]', body);
    if (site) site.onclick = function () {
      var u = d.source === 'md' ? 'https://mangadex.org/title/' + d.id : d.url;
      openSite(u, d.title);
    };
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
          $('#rdChapList', body).innerHTML = '<div class="rd-empty">Chapters could not be loaded. Open MangaDex directly instead.</div>';
        });
      } else paintChapters('');
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
      host.innerHTML = '<div class="rd-chaps">' + list.slice(0, 400).map(function (c) {
        var label = c.chapter ? 'Ch. ' + c.chapter : 'Oneshot';
        var done = prog && prog.chapterId === c.id;
        return '<button class="rd-chap" type="button" data-rd-chap="' + esc(c.id) + '">' +
          '<span class="n">' + esc(label) + '</span><span class="t">' + esc(c.title || 'Chapter ' + c.chapter) + '</span>' +
          '<span class="g">' + esc(c.group || '') + '</span><span class="d">' + esc(fmtDate(c.date)) + '</span>' +
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
      }
    };
  }

  function openFirst(d) {
    if (d.source === 'md') {
      if (!d.chapters || !d.chapters.length) { toast('Chapters are still loading'); return; }
      var ch = d.chapters[d.chapters.length - 1];
      openMdChapter(d, ch);
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
        '<button class="rd-btn gold" type="button" id="rdROpen">Open on MangaDex</button></div>';
      var b = readerEl && $('#rdROpen', readerEl);
      if (b) b.onclick = function () { openSite('https://mangadex.org/chapter/' + chapter.id, manga.title); };
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
        '<button class="rd-btn gold" type="button" id="rdROpen">Open on WEBTOON</button></div>';
      var b = readerEl && $('#rdROpen', readerEl);
      if (b) b.onclick = function () { openSite(ep.url, series.title); };
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
    $$('[data-rd-source]', root).forEach(function (b) {
      b.onclick = function () {
        var s = b.getAttribute('data-rd-source');
        if (!s || s === state.source) return;
        state.source = s;
        state.items = [];
        state.offset = 0;
        state.genre = '';
        state.q = '';
        paint();
        if (s === 'md') mdLoad(false); else wtLoad();
      };
    });
    var form = $('#rdForm', root);
    if (form) form.onsubmit = function (e) {
      e.preventDefault();
      state.q = String($('#rdSearch', root).value || '').trim();
      state.genre = '';
      paintChips();
      if (state.source === 'md') mdLoad(false); else wtLoad();
    };
    var input = $('#rdSearch', root);
    if (input) input.oninput = function () {
      clearTimeout(searchTimer);
      var v = input.value.trim();
      if (!v) return;
      searchTimer = setTimeout(function () {
        state.q = v;
        state.genre = '';
        paintChips();
        if (state.source === 'md') mdLoad(false); else wtLoad();
      }, 520);
    };
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
        if (state.source === 'md') mdLoad(false); else wtLoad();
      };
    });
    root.onclick = function (e) {
      var chip = e.target.closest('[data-rd-genre]');
      if (chip) {
        state.genre = chip.getAttribute('data-rd-genre') || '';
        state.q = '';
        paintChips();
        var inp = $('#rdSearch', root);
        if (inp) inp.value = '';
        if (state.source === 'md') mdLoad(false); else wtLoad();
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
        if (!state.items.length) {
          if (state.source === 'md') mdLoad(false); else wtLoad();
        }
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
})();
