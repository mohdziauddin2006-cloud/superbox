/* renderer.js - SuperBox v4 clean core.
   ---------------------------------------------------------------------------
   - Sidebar: Home, Movies, Series, Web Series, K-Drama, Anime, Kids, 18+,
     Cartoons, Live TV, Tube. The 18+ vault holds JAV / Eporner / Rule34 /
     MMS / Adult Web Series / Adult Movies / Hentai / AI Video behind chips.
   - Search: Home runs a Super Search (TMDB + Anime + K-Drama + Web Series +
     YouTube in labeled rows, strictly SFW); Anime / K-Drama / Web Series /
     Live TV / Tube / 18+ each carry their own search strip scoped to that
     tab's sources only. Nothing about playback or search is ever persisted.
   - ONE player surface: local <video> for raw streams, iframe only for
     isolated embeds. There is NO server dropdown, NO scanner readout, NO
     counters anywhere in this file or the markup.
   - TMDB titles: provider hosts are checked server-side for reachability and
     the best live one is mounted directly. 429s, timeouts, dead mirrors and
     Cloudflare challenges are caught and skipped without a visible word.
   - Custom library cards (XMaal, KatMovieHD, KDramasMaza, AniMixPlay,
     Eporner, Rule34, Hentaicity, Hentai.tv) route through the local
     /extract backend or their own decoder straight into the native player.
   - Failure at every level ends in ONE clean "Stream unavailable" overlay. */
(function () {
  'use strict';
  var Z = window.ZAI || {};
  var SC = window.SC || {};
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[m]);
    });
  };
  function el(t, c, x) { var d = document.createElement(t); if (c) d.className = c; if (x != null) d.textContent = x; return d; }

  /* ---------------- state ---------------- */
  /* Zero-history build: purge every legacy watch/search/resume key before the
     app reads its settings. Future sessions never recreate any of them. */
  function purgeLegacyHistory() {
    try {
      var kill = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i) || '';
        if (/history|recent|continue|resume|watched|watchlater|watch_later|search/i.test(k) && !/^wab\.(key|lang)$/i.test(k)) kill.push(k);
      }
      kill.forEach(function (k) { try { localStorage.removeItem(k); } catch (e) {} });
    } catch (e) {}
  }
  purgeLegacyHistory();
  var store = {};
  try {
    store.key = localStorage.getItem('wab.key') || '';
    store.lang = localStorage.getItem('wab.lang') || 'en-US';
  } catch (e) { store = { key: '', lang: 'en-US' }; }
  var state = { section: 'home', sub: 'jav', current: null, hls: null, next: null, subs: null, audioPicked: false, naturalEnd: false, failed: new Map(), cfDead: new Set(), embedStuck: null, cfChk: null, liveFilter: '', series: null };

  /* Grace period for a source that is still fetching its first frame. A
     live connection that delivers bytes keeps its full window; the
     progress-aware stall check in playStream rotates a socket that answers
     nothing after 15s. This floor only prevents a plainly-too-short explicit
     watchdog from killing a slow-but-working source. */
  var SOURCE_GRACE_MS = 20000;
  function sourceGrace(ms) { return Math.max(SOURCE_GRACE_MS, Number(ms) || 0); }

  /* Cloudflare challenge log, fed by main.js webRequest sniffing: an embed
     that answers with a challenge (403/503 + cf-mitigated, or a turnstile
     challenge-platform frame) lands here so the provider is dropped
     silently - never a visible "Verify you are human" screen. */
  var cfLog = [];
  var embMediaT = 0;
  try {
    window.bridge && window.bridge.onCf && window.bridge.onCf(function (m) {
      if (!m || !m.t) return;
      cfLog.push(m);
      if (cfLog.length > 300) cfLog.splice(0, 150);
    });
  } catch (e) {}

  function cfHit(url, since) {
    try {
      var host = '';
      try { host = new URL(url).host.replace(/^www\./i, ''); } catch (e) { host = String(url || ''); }
      if (!host) return false;
      for (var i = cfLog.length - 1; i >= 0; i--) {
        var ev = cfLog[i];
        if (ev.t < since) break;
        if (String(ev.u).indexOf(host) >= 0) return true;
        for (var j = 0; j < (ev.c || []).length; j++) { if (String(ev.c[j]).indexOf(host) >= 0) return true; }
      }
    } catch (e) {}
    return false;
  }

  /* A proxied player page whose content is missing says so by posting
     {__zaiDead:1} (see the ENHANCER in srv2.js) - the current embed mount
     then rotates to the next provider silently. The same ENHANCER posts
     {__zaiMedia:{...}} while its own <video> runs; kept on the window so the
     app can verify real in-frame progress even though the frame is
     cross-origin. */
  window.addEventListener('message', function (e) {
    if (e && e.data && e.data.__zaiDead && state.embedStuck) {
      var fn = state.embedStuck;
      state.embedStuck = null;
      clearTimeout(state.stallT);
      state.stallT = null;
      try { fn(); } catch (err) {}
    }
    if (e && e.data && typeof e.data.__zaiMedia !== 'undefined') {
      /* Many frames report every second; a fresh real progress report wins
         over the nulls of idle sibling frames for a few seconds. */
      var mm = e.data.__zaiMedia;
      if (mm) embMediaT = Date.now();
    }
  });

  function save() {
    try {
      localStorage.setItem('wab.key', store.key || '');
      localStorage.setItem('wab.lang', store.lang || 'en-US');
    } catch (e) {}
  }
  function toast(msg) {
    var t = el('div', 'toast', msg);
    document.body.appendChild(t);
    setTimeout(function () { try { t.remove(); } catch (e) {} }, 2600);
  }

  /* ---------------- tiny network helpers ---------------- */
  function withTimeout(p, ms) {
    return Promise.race([p, new Promise(function (_z, rej) { setTimeout(function () { rej(new Error('timeout')); }, ms); })]);
  }
  async function fetchJSON(u, ms) {
    var r = await withTimeout(fetch(u, { cache: 'no-store' }), ms || 12000);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await withTimeout(r.json(), ms || 12000);
  }

  /* TMDB: user key -> direct; otherwise the local proxy injects the baked key. */
  async function api(path, params) {
    var q = new URLSearchParams(params || {});
    if (!q.get('language')) q.set('language', store.lang || 'en-US');
    var qs = q.toString();
    if (store.key) return fetchJSON('https://api.themoviedb.org/3' + path + (qs ? '?' + qs : ''));
    var B = await SC.base();
    return fetchJSON(B + '/tmdb/3' + path + (qs ? '?' + qs : ''), 15000);
  }

  function normTmdb(m) {
    var mt = m.media_type || (m.first_air_date ? 'tv' : 'movie');
    var rel = m.release_date || m.first_air_date || '';
    var future = false;
    try { future = !!(rel && new Date(rel + 'T23:59:59') > new Date()); } catch (e) {}
    return {
      kind: 'tmdb', tmdb: m.id, mt: mt === 'tv' ? 'tv' : 'movie',
      t: m.title || m.name || '', poster: m.poster_path ? 'https://image.tmdb.org/t/p/w342' + m.poster_path : '',
      year: (rel || '').slice(0, 4),
      rating: m.vote_average ? m.vote_average.toFixed(1) : '',
      release: rel, future: future, badge: future ? 'TRAILER' : ''
    };
  }

  /* ---------------- SuperBox catalogue (native, ad-free) ---------------- */
  var MB = { home: null, homeAt: 0, homeP: null, idx: [], idxAt: 0, trend: {} };

  async function mbApi(path) {
    var B = await SC.base();
    return fetchJSON(B + '/mb/' + path, 22000);
  }
  function mbDetailUrl(dp) {
    return 'https://movieboxph.org/movies/' + String(dp || '').replace(/^\/+/, '');
  }
  function mbYear(s) { return String((s && s.releaseDate) || '').slice(0, 4); }
  function mbRating(s) {
    var r = Number(s && s.imdbRatingValue);
    return isFinite(r) && r > 0 ? r.toFixed(1) : '';
  }
  function mbNormalize(s) {
    if (!s) return null;
    var id = s.subjectId || s.id;
    var dp = s.detailPath || '';
    if (!id || !dp) return null;
    var cover = (s.cover && s.cover.url) || s.poster || '';
    return {
      kind: 'mb', mbId: String(id), dp: dp,
      t: s.title || s.name || '', poster: cover,
      year: mbYear(s), rating: mbRating(s),
      genre: s.genre || '', country: s.countryName || '',
      stype: Number(s.subjectType) || 0,
      desc: s.description || '', badge: 'SB'
    };
  }
  function mbAddIndex(items) {
    var seen = {};
    (MB.idx || []).forEach(function (x) { seen[x.mbId] = 1; });
    (items || []).forEach(function (it) {
      if (!it || !it.mbId || seen[it.mbId]) return;
      seen[it.mbId] = 1;
      MB.idx.push(it);
    });
    if (MB.idx.length > 1200) MB.idx = MB.idx.slice(-1200);
    MB.idxAt = Date.now();
  }
  function mbHome(force) {
    if (!force && MB.home && Date.now() - MB.homeAt < 300000) return Promise.resolve(MB.home);
    if (MB.homeP) return MB.homeP;
    MB.homeP = mbApi('home').then(function (j) {
      MB.homeP = null;
      if (!j || !j.data) throw new Error('SuperBox catalogue unavailable');
      MB.home = j.data;
      MB.homeAt = Date.now();
      var all = [];
      (j.data.operatingList || []).forEach(function (op) {
        var b = op.banner && op.banner.items;
        if (b && b.length) b.forEach(function (x) { all.push(mbNormalize(x.subject || x)); });
        (op.subjects || []).forEach(function (x) { all.push(mbNormalize(x.subject || x)); });
      });
      mbAddIndex(all.filter(Boolean));
      return MB.home;
    }).catch(function (e) {
      MB.homeP = null;
      throw e;
    });
    return MB.homeP;
  }
  function mbBannerItems(home) {
    var op = (home.operatingList || []).filter(function (o) {
      return o.type === 'BANNER' && o.banner && (o.banner.items || []).length;
    })[0];
    if (!op) return [];
    return op.banner.items.map(function (b, i) {
      var s = b.subject || {};
      var it = mbNormalize(s);
      if (!it) return null;
      var wide = (b.image && b.image.url) || (s.stills && s.stills[0]) || it.poster;
      return Object.assign(it, {
        bg: wide || it.poster,
        t: s.title || b.title || it.t,
        desc: s.description || '',
        idx: i
      });
    }).filter(function (x) { return x && (x.bg || x.poster); }).slice(0, 9);
  }
  function mbCleanTitle(t) {
    return String(t || '').replace(/^[^A-Za-z0-9]+/, '').replace(/\s+/g, ' ').trim() || 'SuperBox';
  }
  async function mbTrending(page) {
    var key = String(page || 1);
    if (MB.trend[key] && Date.now() - MB.trend[key].t < 180000) return MB.trend[key].items;
    var j = await mbApi('trending?page=' + encodeURIComponent(key) + '&perPage=24&tabId=0');
    var list = (j && j.data && j.data.subjectList) || [];
    var items = list.map(mbNormalize).filter(Boolean);
    MB.trend[key] = { t: Date.now(), items: items };
    mbAddIndex(items);
    return items;
  }
  function mbRows(home) {
    var rows = [{ t: 'Trending Now', kind: 'mbtr', page: 1 }];
    (home.operatingList || []).forEach(function (op) {
      var list = (op.subjects || []).map(function (x) { return mbNormalize(x.subject || x); }).filter(Boolean);
      if (!list.length) return;
      if (op.type !== 'SUBJECTS_MOVIE' && op.type !== 'APPOINTMENT_LIST') return;
      rows.push({ t: mbCleanTitle(op.title), kind: 'mblist', items: list });
    });
    rows.push({ t: 'More Like This', kind: 'mbtr', page: 2 });
    return rows;
  }
  function mbSearchLocal(q) {
    var words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return (MB.idx || []).filter(function (it) {
      var h = (it.t + ' ' + (it.genre || '') + ' ' + (it.country || '') + ' ' + (it.year || '')).toLowerCase();
      return words.every(function (w) { return h.indexOf(w) >= 0; });
    }).slice(0, 40);
  }
  async function mbSearch(q) {
    await mbHome().catch(function () {});
    var list = mbSearchLocal(q);
    if (list.length) return list;
    /* The upstream search endpoint currently rejects anonymous tokens (the
       public site itself returns "No results"), so a few extra trending
       pages extend the searchable index instead of showing a dead end. */
    try {
      var pages = await Promise.all([mbTrending(2).catch(function () { return []; }), mbTrending(3).catch(function () { return []; })]);
      pages.forEach(function (p) { mbAddIndex(p); });
    } catch (e) {}
    return mbSearchLocal(q);
  }

  async function anilist(sort, fmt) {
    var q = '{Page(perPage:26){media(type:ANIME,sort:' + sort + (fmt ? ',format:' + fmt : '') + ',isAdult:false){id title{romaji english} coverImage{large} startDate{year} averageScore}}}';
    var r = await withTimeout(fetch('https://graphql.anilist.co', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q })
    }), 12000);
    var j = await r.json();
    var list = (j && j.data && j.data.Page && j.data.Page.media) || [];
    return list.map(function (m) {
      return { kind: 'al', t: m.title.english || m.title.romaji || '', poster: (m.coverImage && m.coverImage.large) || '',
               year: (m.startDate && m.startDate.year) || '', rating: m.averageScore ? (m.averageScore / 10).toFixed(1) : '' };
    });
  }

  async function anilistSearch(q) {
    var g = '{Page(perPage:14){media(type:ANIME,search:' + JSON.stringify(String(q)) + ',isAdult:false){id title{romaji english} coverImage{large} startDate{year} averageScore}}}';
    var r = await withTimeout(fetch('https://graphql.anilist.co', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: g })
    }), 10000);
    var j = await r.json();
    var list = (j && j.data && j.data.Page && j.data.Page.media) || [];
    return list.map(function (m) {
      return { kind: 'al', t: m.title.english || m.title.romaji || '', poster: (m.coverImage && m.coverImage.large) || '',
               year: (m.startDate && m.startDate.year) || '', rating: m.averageScore ? (m.averageScore / 10).toFixed(1) : '' };
    });
  }

  async function arcRow(arc) {
    var u = 'https://archive.org/advancedsearch.php?q=' + encodeURIComponent('collection:' + arc + ' AND mediatype:movies') +
            '&fl[]=identifier&fl[]=title&fl[]=year&rows=26&page=1&output=json';
    var B = await SC.base();
    var j = await fetchJSON(B + '/page?url=' + encodeURIComponent(u), 16000);
    return ((j && j.response && j.response.docs) || []).map(function (d) {
      return { kind: 'arc', t: d.title || d.identifier, arc: d.identifier, year: d.year || '',
               poster: 'https://archive.org/services/img/' + d.identifier };
    });
  }

  async function tmdbRow(row) {
    if (row.al) return anilist(row.al, row.fmt);
    if (row.arc) return arcRow(row.arc);
    var j = await api(row.p, row.q || {});
    /* Unreleased titles never belong in a default catalog row - they have no
       streams anywhere and only produce dead provider carousels. */
    return (j.results || []).map(normTmdb).filter(function (it) { return !it.future; });
  }

  async function tmdbSearch(q, adult) {
    var j = await api('/search/multi', { query: q, include_adult: adult ? 'true' : 'false' });
    return (j.results || []).filter(function (x) { return x.media_type === 'movie' || x.media_type === 'tv'; }).map(normTmdb);
  }

  /* Adult Movies vault rows: TMDB keyword erotica (155477) via the key-injecting
     proxy; items ride the standard provider race like every other TMDB title. */
  async function advRow(row) {
    var j = await api('/discover/movie', row.q || {});
    return (j.results || []).map(function (m) { var it = normTmdb(m); it.badge = '18+'; it.future = false; return it; });
  }

  /* ---------------- section row tables ---------------- */
  function rowsFor(sec, sub) {
    var T = Z.TMDB_ROWS || {}, out = [];
    function tmdb(list) { return (list || []).map(function (r) { return Object.assign({ kind: 'tmdb' }, r); }); }
    if (sec === 'home' || sec === 'movie' || sec === 'tv' || sec === 'kids') return tmdb(T[sec]);
    if (sec === 'webseries') {
      /* The XMaal rows are Desi WEB SERIES catalogues: every card they build is
         tagged isSeries + type:'tv' (see Z.xmaalRows) so the player is required
         to mount the Season/Episode dropdown + Prev/Next for them. */
      out = (Z.xmaalRows ? Z.xmaalRows((Z.XMAAL && Z.XMAAL.sfw) || [], 'XS')
                         : (((Z.XMAAL && Z.XMAAL.sfw) || []).map(function (r) { return { kind: 'xs', t: r[1], path: r[0], badge: 'XS', series: true }; })));
      out = out.concat((Z.KAT.ws || []).map(function (r) { return { kind: 'kat', t: r.t, u: r.u, k: 'kat', badge: 'KAT' }; }));
      return out.concat(tmdb(T.webseries));
    }
    if (sec === 'kdrama') {
      out = (Z.KAT.kd || []).map(function (r) {
        var k = r.k || 'kd';
        return { kind: k === 'hd' ? 'hd' : 'kat', t: r.t, u: r.u, k: k, badge: k === 'kd' ? 'KD' : (k === 'hd' ? 'HD' : 'KAT') };
      });
      return out.concat(tmdb(T.kdrama));
    }
    if (sec === 'anime') {
      /* The legacy anime scrapes (AniMixPlay, PikaHD) can list series but
         their players can no longer hand out a stream - the section is
         backed by the TMDB/AniList anime rows, which play through the
         provider pool like every other section. */
      return tmdb(T.anime);
    }
    if (sec === 'tube') return (Z.YT_ROWS || []).slice();
    if (sec === 'adult') return (((Z.VAULT || {})[sub || state.sub || 'jav']) || []).slice();
    if (sec === 'cartoons') return ((Z.ARCHIVE_ROWS || {}).cartoons || []).map(function (r) { return Object.assign({ kind: 'arc' }, r); });
    return [];
  }

  async function loadRow(row) {
    if (row.kind === 'tmdb') return tmdbRow(row);
    if (row.kind === 'mb') return row.items || [];
    if (row.kind === 'mblist') return row.items || [];
    if (row.kind === 'mbtr') return mbTrending(row.page || 1);
    if (row.kind === 'adv') return advRow(row);
    if (row.kind === 'xs') return SC.xsRow(row.path, row);
    if (row.kind === 'kat') return SC.katRow({ t: row.t, u: row.u, k: row.k || 'kat' });
    if (row.kind === 'hd') return SC.hdRow(row);
    if (row.kind === 'anx') return SC.anxRow(row.path);
    if (row.kind === 'arc') return arcRow(row.arc);
    if (row.kind === 'ep') return SC.epRow(row);
    if (row.kind === 'r34') return SC.r34Row(row);
    if (row.kind === 'r34v') return SC.r34vRow(row);
    if (row.kind === 'jav') return SC.javRow(row);
    if (row.kind === 'hc') return SC.hcRow(row);
    if (row.kind === 'htv') return SC.htvRow(row);
    if (row.kind === 'ytr') return SC.ytRow(row);
    if (row.kind === 'ai') return SC.aiRow(row);
    return [];
  }

  /* ---------------- content rendering ---------------- */
  var rowIO = null;
  function content() { return $('#content'); }

  function paintRow(label, row) {
    var wrap = el('div', 'row');
    wrap.appendChild(el('h3', null, label));
    var strip = el('div', 'row-scroll');
    var ph = el('div', 'empty', 'Loading...');
    strip.appendChild(ph);
    wrap.appendChild(strip);
    var prev = el('button', 'row-nav prev', '\u2039');
    var next = el('button', 'row-nav next', '\u203A');
    prev.type = 'button'; next.type = 'button';
    prev.setAttribute('aria-label', 'Scroll row left');
    next.setAttribute('aria-label', 'Scroll row right');
    prev.onclick = function (ev) { ev.stopPropagation(); strip.scrollBy({ left: -Math.max(320, strip.clientWidth * 0.82), behavior: 'smooth' }); };
    next.onclick = function (ev) { ev.stopPropagation(); strip.scrollBy({ left: Math.max(320, strip.clientWidth * 0.82), behavior: 'smooth' }); };
    wrap.appendChild(prev);
    wrap.appendChild(next);
    wrap.__row = row;
    wrap.__strip = strip;
    wrap.__loaded = false;
    return wrap;
  }

  /* Cards that are thumbnails, logos or junk never reach a row, and the same
     title never shows twice in one row (scrapers repeat heroes/pinned posts). */
  var CARD_JUNK = /^(logo|site\s*logo|untitled|no\s*title|image|img|photo|thumbnail|poster|banner|screenshot|picture|placeholder|watch|home|menu|next|prev(ious)?|more|share|comment|reply|admin|edit)$/i;
  function normPostUrl(u) { return String(u || '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase(); }
  /* Rule34 posts get a strict identity: the post/video id when the URL
     carries one, otherwise the normalized media URL - a Set of those keys
     guarantees the exact same post never renders twice in one row, even
     when the feed repeats it with cosmetic URL differences. */
  function postKey(it) {
    var pg = String(it.page || '');
    var m = pg.match(/\/(?:video|videos|post|posts|view)\/(\d+)/i) || pg.match(/[?&](?:id|video_id|post_id)=(\d+)/i);
    if (m) return 'r34:' + m[1];
    var fm = normPostUrl(it.file);
    if (fm) return 'r34f:' + fm;
    return 'r34p:' + normPostUrl(pg);
  }
  function dedupeItems(items) {
    var seen = {}, out = [], postSeen = new Set();
    (items || []).forEach(function (it) {
      if (!it) return;
      var t = String(it.t || '').trim();
      if (!t || t.length < 2 || CARD_JUNK.test(t)) return;
      if (it.kind === 'r34' || it.kind === 'r34v') {
        var pk = postKey(it);
        if (!pk || postSeen.has(pk)) return;
        postSeen.add(pk);
      }
      var key = it.page || it.file || (it.url || '') || ((it.tmdb || '') + ':' + (it.mt || '') + ':' + t);
      if (seen[key]) return;
      seen[key] = 1;
      out.push(it);
    });
    return out;
  }

  /* ---------------- episodes that arrive as a LIST of cards ----------------
     Not every episodic source has a backend ladder: hentai.tv ships one JSON
     item per episode ("Show - Ep 3"), an XMaal season lists its episodes as
     separate cards, JAV parts are separate pages. Those cards make a
     REAL episode ladder here - grouped by the show's identity (the title with
     its episode tail removed, or the series/ep fields the scraper attached)
     and annotated with the ladder, so the player's Season/Episode selector and
     Prev Ep / Next Ep work exactly as they do for backend ladders. */
  var EP_TAIL_RE = /(?:^|[\s\-–—_:·|.\[(])(?:(?:s(?:eason)?\s*(\d{1,2}))\s*[._-]?\s*)?(?:e|ep|episode|part|pt|vol|volume|chapter|chap)\s*\.?\s*(\d{1,3})(?:\s*[\])\]]?)\s*$/i;
  /* The same token ANYWHERE in the title ("Psychedelic Love EP2 ..." carries
     the site suffix after it). Used only to group cards from ONE row, so two
     explicit episodes of the same show list together instead of each looking
     like a lone "Episode 1". */
  var EP_ANY_RE = /(?:^|[\s\-–—_:·|.\[(])(?:(?:s(?:eason)?\s*(\d{1,2}))\s*[._-]?\s*)?(?:e|ep|episode|part|pt|vol|volume|chapter|chap)\s*\.?\s*(\d{1,3})(?=$|[\s\-–—_:·|.)\]])/i;
  var GROUPABLE_KIND = /^(xs|kat|kd|hd|anx|mv|hc|htv|ai)$/;
  function seriesKeyOf(it) {
    var s = String((it && it.series) || '').trim();
    var ep = Number(it && it.ep) || 0;
    if (s && ep) return { key: 's:' + s.toLowerCase().replace(/\s+/g, ' '), ep: ep, base: s };
    var t = String((it && it.t) || '').trim();
    var m = t.match(EP_TAIL_RE);
    if (m) {
      var base = t.slice(0, m.index).replace(/[\s\-–—_:·|.\[(]+$/, '').trim();
      if (base.length >= 2) return { key: 't:' + base.toLowerCase().replace(/\s+/g, ' '), ep: Number(m[2]) || 0, base: base };
    }
    var m2 = t.match(EP_ANY_RE);
    if (m2) {
      var base2 = t.slice(0, m2.index).replace(/[\s\-–—_:·|.\[(]+$/, '').trim();
      if (base2.length >= 2) return { key: 't:' + base2.toLowerCase().replace(/\s+/g, ' '), ep: Number(m2[2]) || 0, base: base2 };
    }
    return null;
  }
  function attachEpisodeGroups(items) {
    if (!items || !items.length) return items;
    var groups = {}, drop = new Set();
    items.forEach(function (it) {
      if (!it || !GROUPABLE_KIND.test(String(it.kind || ''))) return;
      var info = seriesKeyOf(it);
      if (!info || !info.ep) return;
      /* Keep the card's own episode number even when the row carries no
         sibling (a lone "E03" card must not pretend to be Episode 1). */
      it.ep = info.ep;
      if (!it.series) it.series = info.base;
      it.__grp = info;
      (groups[info.key] = groups[info.key] || []).push(it);
    });
    Object.keys(groups).forEach(function (k) {
      var list = groups[k], seen = {}, uniq = [], dups = [];
      list.forEach(function (it) {
        /* A second card for the SAME episode of the SAME show (mirror host,
           re-listed page, cosmetic URL) is a DUPLICATE, not a new episode. */
        if (seen[it.__grp.ep]) { dups.push(it); return; }
        seen[it.__grp.ep] = 1;
        uniq.push(it);
      });
      var bail = function () {
        uniq.forEach(function (it) { delete it.__grp; });
        dups.forEach(function (it) { delete it.__grp; });
      };
      if (uniq.length < 2) return bail();
      uniq.sort(function (a, b) { return a.__grp.ep - b.__grp.ep; });
      var ladder = uniq.map(function (it) {
        return { n: it.__grp.ep, s: 0, url: String(it.page || it.url || ''), t: String(it.t || '') };
      }).filter(function (e2) { return !!e2.url; });
      if (ladder.length < 2) return bail();
      uniq.forEach(function (it) {
        it.__grp.ladder = ladder;
        it.__grp.title = it.__grp.base;
      });
      /* Only a real ladder may remove cards: the extra cards of an episode
         the ladder already carries are the duplicates the viewer must never
         see twice in the same row. */
      dups.forEach(function (it) { drop.add(it); });
    });
    if (!drop.size) return items;
    return items.filter(function (it) { return !drop.has(it); });
  }

  /* Cross-row Rule34 memory for the ACTIVE vault sub-page: a post that already
     rendered in one row of the current 18+ group is never rendered again by a
     sibling row (the vault rows overlap heavily). Reset whenever the vault
     page is (re)entered, so switching categories always starts clean. */
  var r34Seen = new Set();
  function r34SeenHas(it) {
    try {
      var k = postKey(it);
      if (!k) return false;
      if (r34Seen.has(k)) return true;
      r34Seen.add(k);
      if (r34Seen.size > 4000) r34Seen = new Set();
      return false;
    } catch (e) { return false; }
  }

  /* Every card list passes through here: row cards are deduped, annotated
     with their episode ladder (when the source listed episodes) and, inside
     the 18+ vault, filtered against the posts already rendered by sibling
     rows of the SAME page. */
  function prepareItems(items) {
    var list = attachEpisodeGroups(dedupeItems(items));
    return list.filter(function (it) {
      return !((it && (it.kind === 'r34' || it.kind === 'r34v')) && r34SeenHas(it));
    });
  }

  async function hydrate(wrap) {
    if (wrap.__loaded) return;
    wrap.__loaded = true;
    var strip = wrap.__strip, row = wrap.__row;
    var hadCache = !!wrap.__cached;
    var timer = 0;
    try {
      /* No catalogue row may sit on "Loading..." forever: the backend already
         bounds every upstream read, and this watchdog covers a mirror that
         never settles at all. */
      var guard = new Promise(function (_ok, bad) {
        timer = setTimeout(function () { bad(new Error('row timeout')); }, 25000);
      });
      var items = prepareItems(await Promise.race([loadRow(row), guard]));
      if (!items || !items.length) {
        /* Keep cached cards on a dead upstream instead of blanking the row. */
        if (hadCache) return;
        strip.innerHTML = '';
        strip.appendChild(el('div', 'empty', 'Nothing available right now.'));
        return;
      }
      strip.innerHTML = '';
      items.slice(0, 40).forEach(function (it) { strip.appendChild(cardNode(it)); });
      wrap.__cached = false;
      cachePut(row, items);
    } catch (e) {
      if (hadCache) return;
      strip.innerHTML = '';
      strip.appendChild(el('div', 'empty', 'Nothing available right now.'));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function posterChain(it) {
    var u = it.poster || '';
    if (!u) return [''];
    if (it.kind === 'tmdb' || it.kind === 'country' || it.kind === 'arc' || it.kind === 'live' || it.kind === 'yt' || it.kind === 'mb' || /^https?:\/\/image\.tmdb\.org/i.test(u)) return [u];
    return SC.imgChain(u);
  }

  /* Hover-intent prefetch: the moment the viewer pauses on a vault card, the
     resolver warms the session/extract cache in the background. Clicking then
     starts in milliseconds even when the upstream is slow, and a card that is
     merely browsed past costs one bounded request. */
  var PREFETCHABLE = { ep: 1, jav: 1, r34v: 1, ai: 1 };
  var prefetchDone = new Set();
  var prefetchBusy = false;
  function prefetchItem(it) {
    if (!it || it.file || state.section !== 'adult') return;
    if (!PREFETCHABLE[it.kind] || !(it.page || it.url)) return;
    var key = String(it.page || it.url);
    if (prefetchDone.has(key) || prefetchBusy) return;
    prefetchDone.add(key);
    if (prefetchDone.size > 160) prefetchDone.clear();
    prefetchBusy = true;
    try {
      SC.extract(key, it.t, 20000).catch(function () {}).then(function () { prefetchBusy = false; });
    } catch (e) { prefetchBusy = false; }
  }

  function cardNode(it, wide) {
    var c = el('div', 'card' + (wide ? ' wide' : ''));
    var w = el('div', 'poster-wrap');
    var img = document.createElement('img');
    img.className = 'poster'; img.referrerPolicy = 'no-referrer'; img.loading = 'lazy'; img.alt = it.t || '';
    var chain = posterChain(it), ci = 0;
    img.onerror = function () { ci++; if (ci < chain.length && chain[ci]) { this.src = chain[ci]; } else { this.onerror = null; this.style.opacity = '.15'; } };
    img.src = chain[0] || '';
    w.appendChild(img);
    if (it.badge) w.appendChild(el('div', 'badge', String(it.badge).slice(0, 8)));
    c.appendChild(w);
    var meta = el('div', 'meta');
    meta.appendChild(el('div', 't', it.t || ''));
    var sub = [it.year, it.rating, it.dur].filter(Boolean).join('  ');
    if (sub) meta.appendChild(el('div', 's', sub));
    c.appendChild(meta);
    c.onclick = function () { openItem(it); };
    var pfTimer = 0;
    c.onmouseenter = function () {
      if (pfTimer) return;
      pfTimer = setTimeout(function () { pfTimer = 0; prefetchItem(it); }, 260);
    };
    c.onmouseleave = function () {
      if (pfTimer) { clearTimeout(pfTimer); pfTimer = 0; }
    };
    return c;
  }

  /* ---------------- cinematic hero (SuperBox catalogue) ---------------- */
  var heroTimer = 0;
  function heroStop() {
    if (heroTimer) { clearInterval(heroTimer); heroTimer = 0; }
  }
  function heroSkeleton() {
    var host = el('div', 'hero-host');
    host.innerHTML = '<div class="hero hero-ph"><div class="hero-skeleton"><div class="b"></div></div></div>';
    return host;
  }
  function mountHero(host, items, opts) {
    heroStop();
    opts = opts || {};
    if (!host || !items || !items.length) { if (host) host.innerHTML = ''; return; }
    host.innerHTML = '';
    var hero = el('div', 'hero');
    var slides = el('div', 'hero-slides');
    var slideEls = items.map(function (it) {
      var d = el('div', 'hero-slide');
      d.style.backgroundImage = 'url("' + String(it.bg || it.poster || '').replace(/"/g, '%22') + '")';
      slides.appendChild(d);
      return d;
    });
    hero.appendChild(slides);
    hero.appendChild(el('div', 'hero-grain'));

    var info = el('div', 'hero-in');
    var kicker = el('div', 'hero-kicker');
    var kickerMain = el('span', null, opts.kicker || 'Featured on SuperBox');
    var kickerSrc = el('span', 'src', 'SuperBox');
    kicker.appendChild(kickerMain);
    kicker.appendChild(kickerSrc);
    info.appendChild(kicker);
    var h1 = el('h1');
    info.appendChild(h1);
    var meta = el('div', 'hero-meta');
    info.appendChild(meta);
    var p = el('p', 'hero-desc');
    info.appendChild(p);
    var actions = el('div', 'hero-actions');
    var bPlay = el('button', 'primary');
    bPlay.type = 'button';
    bPlay.appendChild(el('span', 'tri', '\u25B6'));
    bPlay.appendChild(document.createTextNode(' Watch now'));
    var bInfo = el('button', 'ghost', 'More info');
    bInfo.type = 'button';
    actions.appendChild(bPlay);
    actions.appendChild(bInfo);
    info.appendChild(actions);
    hero.appendChild(info);

    var count = el('div', 'hero-count');
    var dots = el('div', 'hero-dots');
    hero.appendChild(count);
    hero.appendChild(dots);
    host.appendChild(hero);

    var dotEls = items.map(function (_it, i) {
      var b = el('button', 'hero-dot' + (i === 0 ? ' on' : ''));
      b.type = 'button';
      b.setAttribute('aria-label', 'Feature ' + (i + 1));
      b.onclick = function () { apply(i); };
      dots.appendChild(b);
      return b;
    });
    var cur = 0;
    function apply(i) {
      if (!hero.isConnected) { heroStop(); return; }
      cur = ((i % items.length) + items.length) % items.length;
      var it = items[cur];
      slideEls.forEach(function (s, k) { s.classList.toggle('on', k === cur); });
      dotEls.forEach(function (d, k) { d.classList.toggle('on', k === cur); });
      h1.textContent = it.t || '';
      p.textContent = it.desc || '';
      p.style.display = it.desc ? '' : 'none';
      meta.innerHTML = '';
      if (it.rating) meta.appendChild(el('span', 'chip rate', '\u2605 ' + it.rating));
      if (it.year) meta.appendChild(el('span', 'chip', it.year));
      if (it.country) meta.appendChild(el('span', 'chip', it.country));
      if (it.genre) meta.appendChild(el('span', 'chip', String(it.genre).split(',')[0]));
      meta.appendChild(el('span', 'chip hd', it.stype === 2 ? 'Series' : 'Movie'));
      meta.appendChild(el('span', 'chip plain', 'SuperBox'));
      count.innerHTML = '';
      count.appendChild(document.createTextNode(String(cur + 1).padStart(2, '0') + ' '));
      count.appendChild(el('b', null, '/ ' + String(items.length).padStart(2, '0')));
      bPlay.onclick = function () {
        if (opts.onPlay) { try { opts.onPlay(it); } catch (e) {} }
        else openItem(it);
      };
      bInfo.onclick = function () { if (opts.onInfo) { try { opts.onInfo(it); return; } catch (e) {} } openItem(it); };
      try { slideEls[cur].style.animation = 'none'; void slideEls[cur].offsetWidth; slideEls[cur].style.animation = ''; } catch (e) {}
    }
    apply(0);
    if (items.length > 1) {
      heroTimer = setInterval(function () {
        if (!hero.isConnected) { heroStop(); return; }
        if (hero.matches(':hover')) return;
        apply(cur + 1);
      }, 8000);
    }
  }
  async function mountHomeHero(host) {
    try {
      var j = await api('/trending/all/week');
      if (state.section !== 'home' || !host || !host.isConnected) return;
      var items = (j.results || []).filter(function (m) {
        return (m.media_type === 'movie' || m.media_type === 'tv' || m.first_air_date || m.release_date) && !m.adult;
      }).map(function (m) {
        var it = normTmdb(m);
        it.bg = m.backdrop_path ? 'https://image.tmdb.org/t/p/original' + m.backdrop_path : it.poster;
        it.desc = m.overview || '';
        it.stype = it.mt === 'tv' ? 2 : 1;
        return it;
      }).filter(function (it) { return it.t && (it.bg || it.poster); }).slice(0, 8);
      if (!items.length) { host.innerHTML = ''; return; }
      mountHero(host, items, {
        kicker: 'Featured on SuperBox',
        onPlay: function (it) { openItem(it); }
      });
    } catch (e) {
      try { if (host && host.isConnected) host.innerHTML = ''; } catch (err) {}
    }
  }

  function brandBand(kicker, title, side, alt) {
    var band = el('div', 'brand-band' + (alt ? ' alt' : ''));
    var left = el('div');
    left.appendChild(el('span', 'bb-kicker', kicker));
    var h = el('h2');
    h.appendChild(document.createTextNode(title || ''));
    left.appendChild(h);
    band.appendChild(left);
    if (side) band.appendChild(el('div', 'bb-side', side));
    return band;
  }
  function skeletonRow() {
    var row = el('div', 'row');
    var strip = el('div', 'row-scroll');
    for (var i = 0; i < 7; i++) {
      var c = el('div', 'sk-card');
      c.appendChild(el('div', 'sk-poster'));
      c.appendChild(el('div', 'sk-line'));
      c.appendChild(el('div', 'sk-line short'));
      strip.appendChild(c);
    }
    row.appendChild(strip);
    return row;
  }

  /* ---------------- sources / reading / shield ---------------- */

  /* The Sources hub hands a URL here instead of launching an external
     browser: an Electron iframe rides the same Shield-proxied session, and
     main.js strips X-Frame-Options/CSP frame-ancestors so real sites mount. */
  var sourceFrame = null;
  function closeSourceFrame() {
    if (sourceFrame) {
      try { sourceFrame.remove(); } catch (e) {}
      sourceFrame = null;
    }
  }
  function openSource(url, title, region) {
    if (!/^https?:\/\//i.test(String(url || ''))) return;
    closeSourceFrame();
    heroStop();
    var box = el('div', 'srcframe');
    var bar = el('div', 'srcbar');
    var back = el('button', null, '\u2190 Back');
    back.type = 'button';
    back.onclick = function () { closeSourceFrame(); renderSection('sources'); };
    var name = el('b', null, title || 'Source');
    var reload = el('button', null, 'Reload');
    reload.type = 'button';
    var note = el('span', null, 'Shield routed');
    var frame = document.createElement('iframe');
    frame.className = 'srcpage';
    frame.setAttribute('allow', 'autoplay *; fullscreen *; encrypted-media *; clipboard-write *');
    frame.setAttribute('allowfullscreen', '');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    var go = function () { try { frame.src = url; } catch (e) {} };
    reload.onclick = go;
    bar.appendChild(back);
    bar.appendChild(name);
    bar.appendChild(note);
    bar.appendChild(reload);
    box.appendChild(bar);
    box.appendChild(frame);
    document.body.appendChild(box);
    sourceFrame = box;
    /* A live Shield connection is reused as-is; restarting it here would
       interrupt the page. Only a down tunnel is re-established on open. */
    var wanted = vpnRegionFor(region);
    note.textContent = 'Shield routed';
    if (wanted && !(vpnLastStatus && vpnLastStatus.ok)) {
      note.textContent = 'Switching Shield\u2026';
      vpnApi('/vpn/ensure?region=' + encodeURIComponent(wanted)).then(function (st) {
        note.textContent = 'Shield \u00b7 ' + ((st && (st.egress || st.regionLabel)) || 'on');
      }).catch(function () {
        note.textContent = 'Shield routed';
      }).then(function () {
        if (sourceFrame === box) go();
      });
    } else {
      go();
    }
  }
  window.SBOpenWeb = openSource;

  function vpnApi(path) {
    return SC.base().then(function (b) {
      return fetch(b + path, { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
    });
  }
  /* Dynamic routing: the VPN prefers the region that matches the source being
     opened or played. Cloudflare's endpoints are anycast, so the actual egress
     is measured and reported truthfully by the Shield status. */
  var vpnAutoTimer = 0;
  var vpnLastStatus = null;
  var VPN_REGION_MAP = {
    IN: 'in', US: 'us', CA: 'ca', UK: 'uk', AU: 'au', DE: 'de', JP: 'jp',
    SG: 'sg', HK: 'hk', KR: 'kr', FR: 'fr', BR: 'br'
  };
  function vpnRegionFor(region) {
    return VPN_REGION_MAP[String((region || '')).toUpperCase()] || '';
  }
  function autoVpnRegion(region) {
    var key = vpnRegionFor(region);
    if (!key) return;
    /* The endpoint pool is anycast: restarting a healthy tunnel to chase a
       country costs a working connection and rarely changes the egress.
       Record the preference (the VPN sheet and next reconnect use it) but do
       not tear down a live tunnel just because a source loaded. */
    if (vpnLastStatus && vpnLastStatus.ok) return;
    clearTimeout(vpnAutoTimer);
    vpnAutoTimer = setTimeout(function () {
      vpnApi('/vpn/ensure?region=' + encodeURIComponent(key)).catch(function () {});
    }, 700);
  }
  var VPN_HOST_REGION = [
    [/bbc\.co\.uk|itv\.com|channel4\.com/i, 'uk'],
    [/9now\.com\.au|abc\.net\.au/i, 'au'],
    [/pluto\.tv|tubitv\.com|sling\.com|stirr\.com|kanopy\.com|hoopladigital\.com|fawesome\.tv|freemoviescinema\.com/i, 'us'],
    [/amazon\.in|hotstar\.com|zee5\.com|sonyliv\.com|voot\.com/i, 'in']
  ];
  function autoVpnForUrl(url) {
    var h = String(url || '');
    for (var i = 0; i < VPN_HOST_REGION.length; i++) {
      if (VPN_HOST_REGION[i][0].test(h)) { autoVpnRegion(VPN_HOST_REGION[i][1]); return; }
    }
  }
  var vpnTimer = 0, vpnFast = true;
  function paintVpnStatus(st) {
    var gate = $('#vpnGate');
    if (!gate) return;
    vpnLastStatus = st || null;
    var on = !!(st && st.ok);
    gate.classList.toggle('hidden', on);
    gate.classList.toggle('on', on);
    gate.classList.toggle('err', !!st && st.state === 'error');
    if ($('#vpnTitle')) $('#vpnTitle').textContent = on ? 'Shield connected' :
      (st && st.state === 'error' ? 'Shield needs a retry' : 'Connecting the Shield');
    if ($('#vpnMsg')) $('#vpnMsg').textContent = on
      ? 'Anonymous WARP tunnel is live. Every request in SuperBox rides it.'
      : (st && st.state === 'error'
        ? 'The tunnel did not come up. Retry, or pick another regional profile.'
        : 'Establishing an anonymous WARP tunnel. Every catalogue, image and stream stays behind it.');
    if ($('#vpnEngine')) $('#vpnEngine').textContent = (st && st.engine) || 'usque · MASQUE';
    if ($('#vpnRegionLabel')) $('#vpnRegionLabel').textContent = (st && st.regionLabel) || 'Global';
    if ($('#vpnEgress')) $('#vpnEgress').textContent = (st && (st.egress || st.ip)) || '—';
    if ($('#vpnWarp')) $('#vpnWarp').textContent = st && st.warp ? 'ON' : (st && st.state) || 'OFF';
    if ($('#vpnErr')) $('#vpnErr').textContent = (st && st.error) ? st.error : '';
    if (st && st.region && $('#vpnRegion') && document.activeElement !== $('#vpnRegion')) {
      try { $('#vpnRegion').value = st.region; } catch (e) {}
    }
    if ($('#setVpnState')) $('#setVpnState').textContent = on
      ? ('Connected · ' + ((st.egress || st.regionLabel || 'WARP')))
      : ((st && (st.state || 'off')) + ' · ' + (st && st.error ? 'retry' : 'connecting'));
  }
  function watchVpn() {
    clearTimeout(vpnTimer);
    vpnApi('/vpn/status').then(function (st) {
      paintVpnStatus(st);
      vpnFast = !st.ok;
      vpnTimer = setTimeout(watchVpn, vpnFast ? 1600 : 8000);
    }).catch(function () {
      var gate = $('#vpnGate');
      if (gate) gate.classList.remove('hidden');
      if ($('#vpnTitle')) $('#vpnTitle').textContent = 'Starting the Shield';
      if ($('#vpnMsg')) $('#vpnMsg').textContent = 'Waiting for the local engine to answer. This usually takes a few seconds.';
      vpnTimer = setTimeout(watchVpn, 1400);
    });
  }
  function startVpnGate() {
    var gate = $('#vpnGate');
    if (!gate) return;
    var sel = $('#vpnRegion');
    if (sel) sel.onchange = function () {
      var region = sel.value || 'auto';
      if ($('#vpnMsg')) $('#vpnMsg').textContent = 'Switching the Shield endpoint to ' + sel.options[sel.selectedIndex].text + '…';
      vpnApi('/vpn/switch?region=' + encodeURIComponent(region)).then(paintVpnStatus).catch(function () {});
    };
    var retry = $('#vpnRetry');
    if (retry) retry.onclick = function () {
      if ($('#vpnErr')) $('#vpnErr').textContent = 'Restarting the tunnel…';
      vpnApi('/vpn/reconnect?region=' + encodeURIComponent((sel && sel.value) || 'auto'))
        .then(paintVpnStatus).catch(function (e) { if ($('#vpnErr')) $('#vpnErr').textContent = e.message || 'Retry failed'; });
    };
    var btn = $('#setVpnBtn');
    if (btn) btn.onclick = function () {
      btn.disabled = true;
      vpnApi('/vpn/reconnect?region=' + encodeURIComponent((sel && sel.value) || 'auto')).then(function (st) {
        paintVpnStatus(st);
        toast('Shield reconnecting.');
        btn.disabled = false;
      }).catch(function () { btn.disabled = false; });
    };
    watchVpn();
  }

  function renderSuperBox() {
    heroStop();
    state.section = 'moviebox';
    try { document.body.setAttribute('data-sec', 'moviebox'); } catch (e) {}
    document.querySelectorAll('#nav button').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-sec') === 'moviebox'); });
    var c = content();
    c.innerHTML = '';
    c.scrollTop = 0;
    if (rowIO) { try { rowIO.disconnect(); } catch (e) {} rowIO = null; }
    c.appendChild(brandBand('Spotlight', 'The blockbuster library', 'Curated \u00B7 Ad-free'));
    c.appendChild(searchStrip('moviebox', 'Search the SuperBox catalogue...'));
    var host = heroSkeleton();
    c.appendChild(host);
    var loading = el('div', 'mb-loading');
    loading.appendChild(skeletonRow());
    loading.appendChild(skeletonRow());
    c.appendChild(loading);
    mbHome().then(function (h) {
      if (state.section !== 'moviebox') return;
      try { loading.remove(); } catch (e) {}
      var items = mbBannerItems(h);
      if (items.length) {
        mountHero(host, items, {
          kicker: 'Featured this week',
          onPlay: function (it) { mbQuickPlay(it); },
          onInfo: function (it) { mbDetail(it); }
        });
      } else { try { host.remove(); } catch (e) {} }
      paintRows(c, mbRows(h));
    }).catch(function () {
      loading.innerHTML = '';
      loading.appendChild(el('div', 'empty', 'SuperBox could not be reached. Check your connection and try again.'));
    });
  }

  function renderSection(sec, sub) {
    closeSourceFrame();
    if (window.READER) { try { window.READER.close(); } catch (e) {} }
    if (sec === 'moviebox') return renderSuperBox();
    heroStop();
    state.section = sec;
    if (sub) state.sub = sub;
    try { document.body.setAttribute('data-sec', sec); } catch (e) {}
    document.querySelectorAll('#nav button').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-sec') === sec); });
    var c = content();
    c.innerHTML = '';
    c.scrollTop = 0;
    if (rowIO) { try { rowIO.disconnect(); } catch (e) {} rowIO = null; }
    if (sec === 'reading') {
      if (window.READER) window.READER.render(c);
      return;
    }
    if (sec === 'sources') {
      if (window.SOURCES_HUB) window.SOURCES_HUB.render(c, { open: openSource });
      return;
    }
    if (sec === 'home') {
      var hh = heroSkeleton();
      c.appendChild(hh);
      mountHomeHero(hh);
    }
    if (sec === 'livetv') return renderLive();
    if (sec === 'adult') return renderVault();
    if (sec === 'anime') c.appendChild(searchStrip(sec, 'Search anime...'));
    if (sec === 'kdrama') c.appendChild(searchStrip(sec, 'Search K-Drama...'));
    if (sec === 'webseries') c.appendChild(searchStrip(sec, 'Search web series...'));
    if (sec === 'tube') c.appendChild(searchStrip(sec, 'Search YouTube...'));
    paintRows(c, rowsFor(sec));
  }

  function vaultLabel(id) {
    var g = (Z.VAULT_GROUPS || []).filter(function (x) { return x.id === id; })[0];
    return (g && g.t) || '18+';
  }

  /* Per-tab search strip: queries ONLY the active tab's own sources (the
     18+ vault strips stay scoped to the active sub-page). */
  function searchStrip(sec, ph) {
    var wrap = el('div', 'sstrip');
    var form = document.createElement('form');
    form.className = 'sform';
    form.autocomplete = 'off';
    var inp = document.createElement('input');
    inp.type = 'search';
    inp.className = 'sinput';
    inp.autocomplete = 'off';
    inp.autocapitalize = 'off';
    inp.spellcheck = false;
    inp.placeholder = ph || 'Search this section...';
    if (sec === 'livetv') inp.oninput = function () { state.liveFilter = inp.value; paintLiveGrid(); };
    form.appendChild(inp);
    var b = el('button', 'primary', 'Search');
    b.type = 'submit';
    form.appendChild(b);
    form.onsubmit = function (e) { e.preventDefault(); runSearch(inp.value); };
    wrap.appendChild(form);
    return wrap;
  }

  /* ---------------- row cache (stale-while-revalidate) ----------------
     Every answered row is persisted, so reopening a section paints instantly
     and then refreshes in the background. A slow or dead upstream keeps the
     last good cards instead of replacing them with "Nothing available". */
  var ROW_CACHE_KEY = 'sb.desktop.rows.v2';
  var rowMem = null;
  var rowSaveTimer = 0;
  function loadRowCache() {
    if (rowMem) return rowMem;
    rowMem = {};
    try {
      var box = JSON.parse(localStorage.getItem(ROW_CACHE_KEY) || 'null');
      if (box && box.rows && typeof box.rows === 'object') rowMem = box.rows;
    } catch (e) { rowMem = {}; }
    return rowMem;
  }
  function rowKey(row) {
    return [row.kind || '', row.p || '', row.q || '', row.u || row.path || '',
      row.k || '', row.t || '', state.sub || ''].join('|').slice(0, 300);
  }
  function cacheTake(row) {
    var mem = loadRowCache();
    var e = mem[rowKey(row)];
    if (!e || !Array.isArray(e.items) || !e.items.length) return null;
    if (Date.now() - (e.at || 0) > 6 * 3600 * 1000) return null;
    return e.items;
  }
  function cachePut(row, list) {
    if (!list || !list.length) return;
    var items = list.slice(0, 40);
    if (JSON.stringify(items).length > 80000) return;
    loadRowCache()[rowKey(row)] = { at: Date.now(), items: items };
    if (rowSaveTimer) clearTimeout(rowSaveTimer);
    rowSaveTimer = setTimeout(function () {
      rowSaveTimer = 0;
      try {
        var mem = loadRowCache();
        var keys = Object.keys(mem);
        if (keys.length > 80) {
          keys.sort(function (a, b) { return (mem[a].at || 0) - (mem[b].at || 0); });
          keys.slice(0, keys.length - 80).forEach(function (k) { delete mem[k]; });
        }
        localStorage.setItem(ROW_CACHE_KEY, JSON.stringify({ v: 2, rows: mem }));
      } catch (e) {
        try { localStorage.removeItem(ROW_CACHE_KEY); } catch (e2) {}
      }
    }, 260);
  }

  function paintRows(c, rows) {
    if (!rows.length) { c.appendChild(el('div', 'empty', 'Nothing here yet.')); return; }
    if (rowIO) { try { rowIO.disconnect(); } catch (e) {} }
    rowIO = null;
    var queue = [];
    rows.forEach(function (row) {
      var wrap = paintRow(row.t, row);
      var cached = cacheTake(row);
      if (cached && cached.length) {
        wrap.__strip.innerHTML = '';
        cached.slice(0, 40).forEach(function (it) { wrap.__strip.appendChild(cardNode(it)); });
        wrap.__cached = true;
      }
      c.appendChild(wrap);
      queue.push(wrap);
    });
    /* Lazy, viewport-driven hydration. The vault exposes dozens of rows per
       tab (Eporner alone has 60); eagerly hydrating every one of them fired a
       continuous burst of upstream requests that rate-limited the very API
       the first click needs. The first rows load immediately, the rest start
       as they approach the viewport (700px of lead), and cached rows paint
       from localStorage first - no row ever sits on "Loading..." once seen. */
    var active = 0, pending = [];
    function pump() {
      while (active < 4 && pending.length) {
        (function (w) {
          active++;
          hydrate(w).then(function () { active--; pump(); }, function () { active--; pump(); });
        })(pending.shift());
      }
    }
    function need(w) {
      if (w.__queued || w.__loaded) return;
      w.__queued = true;
      pending.push(w);
      pump();
    }
    queue.slice(0, 4).forEach(need);
    if (typeof IntersectionObserver !== 'undefined') {
      rowIO = new IntersectionObserver(function (ents) {
        ents.forEach(function (en) {
          if (!en.isIntersecting) return;
          try { rowIO.unobserve(en.target); } catch (e) {}
          need(en.target);
        });
      }, { root: c, rootMargin: '700px 0px' });
      queue.slice(4).forEach(function (w) { rowIO.observe(w); });
    } else {
      queue.forEach(need);
    }
  }

  /* 18+ vault: one sidebar entry, sub-nav chips for every adult group. */
  function renderVault() {
    var c = content();
    var sub = state.sub || 'jav';
    /* Entering (or re-entering) the vault resets the cross-row post memory:
       switching categories always starts clean, then overlapping rows of
       THIS sub-page never render the same post twice. */
    r34Seen = new Set();
    var bar = el('div', 'subnav');
    (Z.VAULT_GROUPS || []).forEach(function (g) {
      var b = el('button', 'chip' + (g.id === sub ? ' active' : ''), g.t);
      b.setAttribute('data-vsub', g.id);
      b.onclick = function (ev) { ev.preventDefault(); state.sub = g.id; renderSection('adult'); };
      bar.appendChild(b);
    });
    c.appendChild(bar);
    c.appendChild(searchStrip('adult', 'Search in ' + vaultLabel(sub) + '...'));
    paintRows(c, rowsFor('adult', sub));
  }

  var liveChs = [];
  function renderLive() {
    var c = content();
    var wrap = el('div', 'row');
    wrap.appendChild(el('h3', null, 'Live TV'));
    var bar = el('div');
    bar.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;align-items:center;padding:0 18px 12px';
    var sel = document.createElement('select');
    sel.className = 'picker';
    sel.style.margin = '0';
    (Z.LIVE.groups || []).forEach(function (g, i) {
      var o = document.createElement('option'); o.value = String(i); o.textContent = g.t; sel.appendChild(o);
    });
    bar.appendChild(sel);
    var inp = document.createElement('input');
    inp.type = 'search';
    inp.className = 'sinput';
    inp.autocomplete = 'off';
    inp.autocapitalize = 'off';
    inp.spellcheck = false;
    inp.style.maxWidth = '280px';
    inp.placeholder = 'Filter channels...';
    inp.oninput = function () { state.liveFilter = inp.value; paintLiveGrid(); };
    bar.appendChild(inp);
    wrap.appendChild(bar);
    var grid = el('div', 'livegrid');
    grid.id = 'liveGrid';
    wrap.appendChild(grid);
    c.appendChild(wrap);

    function loadGroup(i) {
      grid.innerHTML = '<div class="empty">Loading channels...</div>';
      SC.liveList(Z.LIVE.groups[i]).then(function (chs) {
        liveChs = chs || [];
        paintLiveGrid();
      });
    }
    sel.onchange = function () { loadGroup(Number(sel.value)); };
    loadGroup(0);
  }

  function paintLiveGrid() {
    var grid = $('#liveGrid');
    if (!grid) return;
    var f = String(state.liveFilter || '').toLowerCase();
    var list = (liveChs || []).filter(function (ch) { return !f || String(ch.name || '').toLowerCase().indexOf(f) >= 0; });
    grid.innerHTML = '';
    if (!list.length) { grid.appendChild(el('div', 'empty', f ? 'No channels match.' : 'No channels responded.')); return; }
    list.slice(0, 160).forEach(function (ch) {
      var d = el('div', 'ch');
      var lo = el('div', 'logo');
      if (ch.logo) {
        var im = document.createElement('img');
        im.loading = 'lazy';
        var lc = SC.imgChain(ch.logo), li = 0;
        im.onerror = function () { li++; if (li < lc.length && lc[li]) { this.src = lc[li]; } else { this.remove(); } };
        im.src = lc[0] || '';
        lo.appendChild(im);
      }
      d.appendChild(lo);
      d.appendChild(el('div', 'nm', ch.name || 'Channel'));
      d.onclick = function () { playLive(ch); };
      grid.appendChild(d);
    });
  }

  /* ---------------- detail view (TMDB titles) ---------------- */
  async function detail(it) {
    var c = content();
    c.innerHTML = '<div class="row"><div class="empty" style="padding:0 18px">Loading details...</div></div>';
    var mt = it.mt === 'tv' ? 'tv' : 'movie';
    var d = null;
    try { d = await api('/' + mt + '/' + it.tmdb, { append_to_response: 'external_ids' }); } catch (e) {}
    if (!d) { toast('Could not load details.'); renderSection(state.section); return; }
    state.current = {
      ref: { type: mt, tmdb: it.tmdb, imdb: (d.external_ids && d.external_ids.imdb_id) || null, season: 1, episode: 1 },
      title: d.title || d.name || it.t,
      poster: d.poster_path ? 'https://image.tmdb.org/t/p/w342' + d.poster_path : '',
      release: d.release_date || d.first_air_date || it.release || ''
    };
    var title = d.title || d.name || it.t || '';
    var year = (d.release_date || d.first_air_date || '').slice(0, 4);
    c.innerHTML = '';
    var box = el('div', 'detail');
    var hero = el('div', 'hero');
    if (d.backdrop_path) hero.style.backgroundImage = 'url(https://image.tmdb.org/t/p/w1280' + d.backdrop_path + ')';
    var hi = el('div', 'hero-in');
    hi.appendChild(el('h1', null, title));
    var sub = [year, d.vote_average ? '★ ' + d.vote_average.toFixed(1) : '', (d.genres || []).map(function (g) { return g.name; }).slice(0, 3).join(' · ')].filter(Boolean).join('   ');
    hi.appendChild(el('div', 'sub', sub));
    if (d.overview) hi.appendChild(el('p', null, d.overview.slice(0, 420)));
    var btns = el('div', 'btns');
    var play = el('button', 'primary', '\u25B6  Play');
    play.onclick = function () {
      /* Series never auto-play: the Play button opens the episode menu and the
         viewer starts playback by clicking an episode. */
      if (mt === 'tv') pickTmdbSeries(state.current);
      else playCurrent();
    };
    btns.appendChild(play);
    var back = el('button', 'ghost', 'Back');
    back.onclick = function () { renderSection(state.section); };
    btns.appendChild(back);
    hi.appendChild(btns);
    hero.appendChild(hi);
    box.appendChild(hero);

    if (mt === 'tv' && (d.seasons || []).length) {
      var secd = el('div', 'section');
      secd.appendChild(el('h3', null, 'Episodes'));
      var sel = document.createElement('select');
      sel.className = 'picker';
      (d.seasons || []).filter(function (s) { return s.season_number >= 0; }).forEach(function (s) {
        var o = document.createElement('option');
        o.value = String(s.season_number);
        o.textContent = s.name + ' (' + s.episode_count + ' episodes)';
        sel.appendChild(o);
      });
      secd.appendChild(sel);
      var grid = el('div', 'epgrid');
      secd.appendChild(grid);
      box.appendChild(secd);
      var loadSeason = async function (n) {
        grid.innerHTML = '<div class="empty">Loading episodes...</div>';
        var sd = null;
        try { sd = await api('/tv/' + it.tmdb + '/season/' + n); } catch (e) {}
        grid.innerHTML = '';
        if (!sd || !(sd.episodes || []).length) { grid.appendChild(el('div', 'empty', 'No episodes listed.')); return; }
        sd.episodes.forEach(function (ep) {
          var b = document.createElement('button');
          b.textContent = 'E' + ep.episode_number + '  ' + (ep.name || '');
          b.onclick = function () {
            /* A late click after the player closed (state cleared) must not
               throw - the episode strip may still be on screen mid-close. */
            if (!state.current) return;
            state.current.ref = state.current.ref || {};
            state.current.ref.season = ep.season_number;
            state.current.ref.episode = ep.episode_number;
            playCurrent();
          };
          grid.appendChild(b);
        });
      };
      sel.onchange = function () { loadSeason(Number(sel.value)); };
      loadSeason(Number(sel.value || 1));
    }
    c.appendChild(box);
  }

  /* ---------------- SuperBox detail + native playback ---------------- */
  function mbSeasonsOf(sub) {
    var res = (sub && sub.__seasons) || [];
    var out = [];
    res.forEach(function (sn) {
      var se = Number(sn && sn.se);
      var max = Number(sn && sn.maxEp) || 0;
      if (!(max > 0)) return;
      out.push({ n: isFinite(se) ? se : 0, maxEp: Math.min(max, 400) });
    });
    out.sort(function (a, b) { return a.n - b.n; });
    return out;
  }
  function mbLadder(sub) {
    return mbSeasonsOf(sub).map(function (s) {
      var eps = [];
      for (var i = 1; i <= s.maxEp; i++) eps.push({ n: i });
      return { n: s.n, eps: eps };
    });
  }
  function mbPickStreams(d) {
    var arr = [];
    (d.streams || []).forEach(function (x) { if (x && x.url && !x.vipLocked) arr.push(x); });
    (d.hls || []).forEach(function (x) {
      if (typeof x === 'string') arr.push({ url: x, format: 'HLS' });
      else if (x && x.url && !x.vipLocked) arr.push(x);
    });
    (d.dash || []).forEach(function (x) {
      if (typeof x === 'string') arr.push({ url: x, format: 'DASH' });
      else if (x && x.url && !x.vipLocked) arr.push(x);
    });
    arr.sort(function (a, b) {
      return (Number(b.resolutions) || Number(b.resolution) || 0) - (Number(a.resolutions) || Number(a.resolution) || 0);
    });
    return arr;
  }
  /* The quality ladder behaves like the native app: remember the viewer's
     choice, default to the smooth 480p tier, never open on a 4 GB file that
     takes half a minute to demux. */
  var MB_Q_KEY = 'sb.mb.quality';
  function mbSavedQuality() { try { return Number(localStorage.getItem(MB_Q_KEY)) || 0; } catch (e) { return 0; } }
  function mbRememberQuality(h) { try { if (h) localStorage.setItem(MB_Q_KEY, String(h)); } catch (e) {} }
  function mbQualityLabel(q) {
    if (!q) return 'Auto';
    if (q.height) return q.height + 'p';
    if (/hls/i.test(String(q.format))) return 'HLS';
    return 'Original';
  }
  function mbChooseQuality(list, want) {
    var asc = (list || []).slice().sort(function (a, b) {
      return (Number(a.height) || 0) - (Number(b.height) || 0);
    });
    if (!asc.length) return null;
    var exact = null, lower = null, smooth = null;
    asc.forEach(function (q) {
      var h = Number(q.height) || 0;
      if (want && h === Number(want)) exact = q;
      if (want && h && h <= Number(want)) lower = q;
      if (!smooth && h >= 360 && h <= 720) smooth = q;
    });
    if (exact) return exact;
    if (lower) return lower;
    if (smooth) return smooth;
    return asc[0];
  }
  function mbAudioLabel(a) {
    if (!a) return 'Audio';
    var n = a.lanName || a.lanCode || 'Audio';
    if (a.original && !/original/i.test(n)) n = 'Original \u00B7 ' + n;
    return n;
  }
  async function mbPlaySubject(sub, se, epn, title, opts) {
    opts = opts || {};
    if (!sub) return;
    var stype = Number(sub.subjectType) || 0;
    var seasons = mbSeasonsOf(sub);
    var isSeries = stype !== 1 && seasons.length > 0 && (seasons.length > 1 || seasons[0].maxEp > 1);
    var base = title || sub.title || 'SuperBox';
    se = isSeries ? (Number(se) || 1) : 0;
    epn = isSeries ? (Number(epn) || 1) : 0;
    var label = base + (isSeries ? ' \u00B7 S' + se + 'E' + epn : '');
    if (isSeries) {
      state.series = {
        mode: 'mb', subject: sub, title: base, season: se, episode: epn,
        seasons: mbLadder(sub)
      };
    } else if (!opts.keepSeries) {
      clearSeries();
    }
    showPlayer(label);
    if (isSeries) paintSeriesControls();
    showLoading('Connecting to SuperBox...');
    var ep0 = playEpoch;
    var psid = opts.audioSubjectId || sub.subjectId;
    var pdp = opts.audioDetailPath || sub.detailPath;
    try {
      var j = await mbApi('play?subjectId=' + encodeURIComponent(psid) +
        '&detailPath=' + encodeURIComponent(pdp) + '&se=' + se + '&ep=' + epn);
      if (ep0 !== playEpoch) return;
      var sb = (j && j.sb) || null;
      if (!sb || !sb.qualities || !sb.qualities.length) {
        /* A handful of long-running shows have a hole at episode 1 (the
           upstream row exists but carries no stream). Starting the next
           episode is better than dead-ending on "Play S13E1", and the viewer
           is told exactly what happened. Explicit later picks never jump. */
        var firstSeason = (mbSeasonsOf(sub) || []).filter(function (x) { return x.n === Number(se); })[0];
        if (isSeries && Number(epn) === 1 && !opts.triedNextEp && firstSeason && firstSeason.maxEp >= 2) {
          try { toast('Episode 1 is unavailable - starting episode 2'); } catch (e2) {}
          var o2 = {};
          Object.keys(opts).forEach(function (k) { o2[k] = opts[k]; });
          o2.keepSeries = true;
          o2.triedNextEp = true;
          mbPlaySubject(sub, se, 2, title, o2);
          return;
        }
        showUnavailable(label, {
          retry: function () { mbPlaySubject(sub, se, epn, title, { keepSeries: true }); },
          message: (j && j.message && j.message !== 'ok') ? String(j.message) : ''
        });
        return;
      }
      var audio = null;
      var want = opts.audioSubjectId ? String(opts.audioSubjectId) : '';
      (sb.audio || []).some(function (a) {
        if (want && String(a.subjectId) === want) { audio = a; return true; }
        if (!want && a.current) { audio = a; return true; }
        return false;
      });
      if (!audio) audio = (sb.audio || [])[0] || null;
      var session = {
        sub: sub, se: se, ep: epn, title: base, label: label,
        play: sb, audio: audio,
        height: Number(opts.height) || 0,
        resumeAt: Number(opts.resumeAt) || 0,
        refreshed: false,
        tried: {}
      };
      if (opts.audioSubjectId) session.label = label + (audio ? ' \u00B7 ' + (audio.lanName || audio.lanCode || 'Audio') : '');
      state.mb = session;
      mbStartSession(session, ep0);
    } catch (e) {
      if (ep0 !== playEpoch) return;
      showUnavailable(label, { retry: function () { mbPlaySubject(sub, se, epn, title, { keepSeries: true }); } });
    }
  }
  function mbProxyInfo(session) {
    var q = session.quality;
    var raw = String(q.url || '');
    if (/^\/\//.test(raw)) raw = 'https:' + raw;
    var isHls = /hls/i.test(String(q.format || '')) || /\.m3u8(?:[?#]|$)/i.test(raw);
    return { url: raw, hls: isHls, ref: mbDetailUrl((session.audio && session.audio.detailPath) || session.sub.detailPath) };
  }
  function mbStartSession(session, ep0) {
    if (!session || !session.play || !session.play.qualities.length) return;
    /* A remembered 1080p must not turn every launch into a 30-second wait on
       a multi-gigabyte file. Only an explicit pick in THIS session opens the
       top tier; otherwise start on the smooth 360-720p rung. */
    var want = session.height || mbSavedQuality();
    if (!session.height && want > 720) want = 0;
    var q = mbChooseQuality(session.play.qualities, want);
    if (!q) return;
    if (session.tried[q.id]) {
      /* Every tier already failed in this session: surface the error. */
      showUnavailable(session.label, { retry: function () { mbPlaySubject(session.sub, session.se, session.ep, session.title, { keepSeries: true }); } });
      return;
    }
    session.quality = q;
    state.mb = session;
    var info = mbProxyInfo(session);
    var at = Number(session.resumeAt) || 0;
    SC.base().then(function (B) {
      if (ep0 !== playEpoch) return;
      var prox = B + (info.hls ? '/hls' : '/raw') + '?url=' + encodeURIComponent(info.url) + '&ref=' + encodeURIComponent(info.ref) +
        (!info.hls && q.size ? '&size=' + Number(q.size) : '');
      playStream(prox, session.label, {
        watchdog: 34000,
        startAt: at,
        onFail: function () {
          if (ep0 !== playEpoch) return;
          /* Signed CDN token expired or edge hiccup: refresh the play payload
             once and retry the same tier before dropping quality. Marking the
             tier as tried BEFORE this retry made mbStartSession bail out and
             surface "unavailable" without ever replaying it. */
          if (!session.refreshed) {
            session.refreshed = true;
            session.resumeAt = mbCurrentTime();
            mbApi('play?subjectId=' + encodeURIComponent(session.play.subjectId || session.sub.subjectId) +
              '&detailPath=' + encodeURIComponent(session.play.detailPath || session.sub.detailPath) +
              '&se=' + session.se + '&ep=' + session.ep).then(function (j) {
              if (ep0 !== playEpoch) return;
              if (j && j.sb && j.sb.qualities && j.sb.qualities.length) {
                session.play = j.sb;
                var again = mbChooseQuality(j.sb.qualities, q.height || want);
                session.height = again ? again.height : session.height;
              }
              mbStartSession(session, ep0);
            }).catch(function () { if (ep0 === playEpoch) { session.tried[q.id] = true; mbFallbackQuality(session, ep0); } });
            return;
          }
          session.tried[q.id] = true;
          mbFallbackQuality(session, ep0);
        }
      });
      syncVideoUI();
    });
  }
  function mbCurrentTime() {
    var v = $('#pVideo');
    var t = v ? Number(v.currentTime) : 0;
    return isFinite(t) && t > 1 ? t : 0;
  }
  /* If a tier is unplayable (a very large non-faststart file, a dead edge),
     step down one rung and keep the exact timestamp. This is what keeps a
     title from ever showing "stream unavailable" while a playable quality
     exists two rows below it. */
  function mbFallbackQuality(session, ep0) {
    if (!session || ep0 !== playEpoch) return;
    var asc = (session.play.qualities || []).slice().sort(function (a, b) {
      return (Number(a.height) || 0) - (Number(b.height) || 0);
    });
    var cur = session.quality;
    var idx = -1;
    asc.forEach(function (q, i) { if (cur && q.id === cur.id) idx = i; });
    var next = null;
    for (var i = idx - 1; i >= 0; i--) {
      if (!session.tried[asc[i].id]) { next = asc[i]; break; }
    }
    if (!next) {
      showUnavailable(session.label, { retry: function () { mbPlaySubject(session.sub, session.se, session.ep, session.title, { keepSeries: true }); } });
      return;
    }
    session.resumeAt = mbCurrentTime();
    session.height = Number(next.height) || 0;
    session.refreshed = true;
    try { toast('Switched to ' + mbQualityLabel(next) + ' for smooth playback'); } catch (e) {}
    mbStartSession(session, ep0);
  }
  function mbSwitchQuality(q) {
    var s = state.mb;
    if (!s || !q) return;
    var at = mbCurrentTime();
    s.resumeAt = at;
    s.height = Number(q.height) || 0;
    s.refreshed = true;
    mbRememberQuality(s.height);
    var ep0 = playEpoch;
    mbStartSession(s, ep0);
  }
  function mbSwitchAudio(a) {
    var s = state.mb;
    if (!s || !a) return;
    var at = mbCurrentTime();
    var keep = s.sub;
    mbPlaySubject(keep, s.se, s.ep, s.title, {
      keepSeries: true,
      audioSubjectId: a.subjectId,
      audioDetailPath: a.detailPath,
      resumeAt: at,
      height: s.height
    });
  }
  function jumpMbEpisode(se, epn) {
    var s = state.series;
    if (!s || s.mode !== 'mb' || !s.subject) return;
    s.season = se;
    s.episode = epn;
    paintSeriesControls();
    mbPlaySubject(s.subject, se, epn, s.title, { keepSeries: true });
  }
  async function mbDetail(it) {
    var c = content();
    c.innerHTML = '<div class="row"><div class="empty" style="padding:0 40px">Loading SuperBox title...</div></div>';
    var j = null;
    try {
      j = await mbApi('detail?subjectId=' + encodeURIComponent(it.mbId) + '&detailPath=' + encodeURIComponent(it.dp) + '&se=0');
    } catch (e) {}
    var d = (j && j.data) || null;
    var s = d && d.subject;
    if (!s) { toast('Could not load this SuperBox title.'); renderSection('moviebox'); return; }
    s.__seasons = (d.resource && d.resource.seasons) || [];
    var title = s.title || it.t || '';
    var year = mbYear(s);
    var rating = mbRating(s);
    var seasons = mbSeasonsOf(s);
    var isSeries = Number(s.subjectType) !== 1 && seasons.length > 0 && (seasons.length > 1 || seasons[0].maxEp > 1);
    var poster = (s.cover && s.cover.url) || it.poster || '';
    var backdrop = (s.stills && s.stills[0]) || (it.bg || poster);
    c.innerHTML = '';
    var box = el('div', 'mb-detail');
    var hero = el('div', 'mb-hero');
    hero.style.backgroundImage = 'url("' + String(backdrop).replace(/"/g, '%22') + '")';
    var hin = el('div', 'mb-hero-in');
    var img = document.createElement('img');
    img.className = 'mb-poster'; img.alt = title; img.src = poster;
    img.onerror = function () { this.style.opacity = '.12'; };
    hin.appendChild(img);
    var info = el('div', 'mb-info');
    var kick = el('div', 'mb-kicker');
    kick.appendChild(el('span', 'badge2', 'SuperBox'));
    kick.appendChild(document.createTextNode('  ' + (isSeries ? 'Series' : 'Movie') + (s.countryName ? ' \u00B7 ' + s.countryName : '')));
    info.appendChild(kick);
    info.appendChild(el('h1', null, title));
    var meta = el('div', 'mb-meta');
    if (rating) meta.appendChild(el('span', 'chip rate', '\u2605 ' + rating));
    if (year) meta.appendChild(el('span', 'chip', year));
    if (s.genre) String(s.genre).split(',').slice(0, 3).forEach(function (g) { meta.appendChild(el('span', 'chip', g.trim())); });
    meta.appendChild(el('span', 'chip src', 'Ad-free stream'));
    info.appendChild(meta);
    if (s.description) info.appendChild(el('p', 'mb-desc', String(s.description).slice(0, 650)));
    var actions = el('div', 'mb-actions');
    var bPlay = el('button', 'primary');
    bPlay.type = 'button';
    bPlay.appendChild(document.createTextNode('\u25B6  '));
    bPlay.appendChild(document.createTextNode(isSeries ? 'Play S' + seasons[0].n + 'E1' : 'Play now'));
    bPlay.onclick = function () {
      if (isSeries) mbPlaySubject(s, seasons[0].n, 1, title);
      else mbPlaySubject(s, 0, 0, title);
    };
    actions.appendChild(bPlay);
    var tr = s.trailer && s.trailer.videoAddress && s.trailer.videoAddress.url;
    if (tr) {
      var bTr = el('button', 'ghost', 'Trailer');
      bTr.type = 'button';
      bTr.onclick = function () {
        showPlayer(title + ' \u00B7 Trailer');
        clearSeries();
        var ep0 = playEpoch;
        SC.base().then(function (B) {
          if (ep0 !== playEpoch) return;
          playStream(B + '/raw?url=' + encodeURIComponent(tr) + '&ref=' + encodeURIComponent(mbDetailUrl(s.detailPath)), title + ' \u00B7 Trailer', { watchdog: 45000 });
        });
      };
      actions.appendChild(bTr);
    }
    var bBack = el('button', 'ghost', 'Back');
    bBack.type = 'button';
    bBack.onclick = function () { renderSection(state.section === 'moviebox' ? 'moviebox' : 'home'); };
    actions.appendChild(bBack);
    info.appendChild(actions);
    hin.appendChild(info);
    hero.appendChild(hin);
    box.appendChild(hero);

    if (isSeries) {
      var secEps = el('div', 'mb-section');
      var head = el('div', 'mb-section-head');
      var h3 = el('h3');
      h3.appendChild(document.createTextNode('Episodes '));
      h3.appendChild(el('em', null, '(' + seasons.reduce(function (a, x) { return a + x.maxEp; }, 0) + ')'));
      head.appendChild(h3);
      var bar = el('div', 'mb-seasonbar');
      var sel = document.createElement('select');
      sel.setAttribute('aria-label', 'Season');
      seasons.forEach(function (sn) {
        var o = document.createElement('option');
        o.value = String(sn.n);
        o.textContent = 'Season ' + sn.n + ' \u00B7 ' + sn.maxEp + ' episodes';
        sel.appendChild(o);
      });
      if (seasons.length > 1) bar.appendChild(sel);
      head.appendChild(bar);
      secEps.appendChild(head);
      var grid = el('div', 'mb-epgrid');
      secEps.appendChild(grid);
      var paintEps = function (se) {
        grid.innerHTML = '';
        var sn = seasons.filter(function (x) { return x.n === se; })[0] || seasons[0];
        for (var i = 1; i <= sn.maxEp; i++) {
          (function (n) {
            var b = el('button', 'mb-ep');
            b.type = 'button';
            b.appendChild(el('span', 'n', String(n)));
            b.appendChild(el('span', 'l', 'Episode ' + n));
            b.onclick = function () { mbPlaySubject(s, se, n, title); };
            grid.appendChild(b);
          })(i);
        }
      };
      sel.onchange = function () { paintEps(Number(sel.value)); };
      paintEps(seasons[0].n);
      box.appendChild(secEps);
    }

    var cast = (s.staffList || []).filter(function (p) { return p && (p.name || p.staffName || p.title); });
    if (cast.length) {
      var secCast = el('div', 'mb-section');
      secCast.appendChild(el('h3', null, 'Cast'));
      var strip = el('div', 'mb-cast');
      cast.slice(0, 24).forEach(function (p) {
        var person = el('div', 'person');
        var av = p.avatarUrl || p.avatar || p.image || (p.avatar && p.avatar.url) || '';
        if (av) {
          var im = document.createElement('img'); im.src = av; im.alt = p.name || '';
          im.onerror = function () { this.remove(); };
          person.appendChild(im);
        } else {
          person.appendChild(el('div', 'ph'));
        }
        person.appendChild(el('div', 'nm', p.name || p.staffName || p.title || ''));
        person.appendChild(el('div', 'role', p.character || p.role || p.characterName || ''));
        strip.appendChild(person);
      });
      secCast.appendChild(strip);
      box.appendChild(secCast);
    }

    var recSec = el('div', 'mb-section');
    var recHead = el('div', 'mb-section-head');
    recHead.appendChild(el('h3', null, 'More from SuperBox'));
    recSec.appendChild(recHead);
    recSec.appendChild(el('div', 'empty', 'Loading suggestions...'));
    box.appendChild(recSec);
    c.appendChild(box);

    mbApi('rec?subjectId=' + encodeURIComponent(s.subjectId) + '&page=1&perPage=18').then(function (rj) {
      if (state.section !== 'moviebox' || !recSec.isConnected) return;
      var items = ((rj && rj.data && rj.data.items) || []).map(mbNormalize).filter(function (x) {
        return x && String(x.mbId) !== String(s.subjectId);
      });
      recSec.innerHTML = '';
      recSec.appendChild(recHead);
      if (!items.length) { recSec.appendChild(el('div', 'empty', 'No suggestions for this title yet.')); return; }
      var strip = el('div', 'row-scroll');
      items.forEach(function (x) { strip.appendChild(cardNode(x)); });
      recSec.appendChild(strip);
    }).catch(function () {
      try {
        recSec.innerHTML = '';
        recSec.appendChild(recHead);
        recSec.appendChild(el('div', 'empty', 'No suggestions for this title yet.'));
      } catch (e) {}
    });
  }
  async function mbQuickPlay(it) {
    try {
      var j = await mbApi('detail?subjectId=' + encodeURIComponent(it.mbId) + '&detailPath=' + encodeURIComponent(it.dp) + '&se=0');
      var d = (j && j.data) || {};
      var s = d.subject;
      if (!s) throw new Error('no subject');
      s.__seasons = (d.resource && d.resource.seasons) || [];
      var seasons = mbSeasonsOf(s);
      var isSeries = Number(s.subjectType) !== 1 && seasons.length > 0 && (seasons.length > 1 || seasons[0].maxEp > 1);
      if (isSeries) mbPlaySubject(s, seasons[0].n, 1, s.title || it.t);
      else mbPlaySubject(s, 0, 0, s.title || it.t);
    } catch (e) {
      toast('SuperBox could not start this title.');
    }
  }

  async function openAl(it) {
    try {
      var j = await api('/search/multi', { query: it.t });
      var f = (j.results || []).find(function (x) { return x.media_type === 'tv' || x.media_type === 'movie'; });
      if (f) { detail(normTmdb(f)); return; }
    } catch (e) {}
    toast('No matching title found.');
  }

  /* ---------------- the player (single clean surface) ---------------- */
  function player() { return $('#playerView'); }
  function stageMsg(html) {
    var m = $('#pMsg');
    hideVideoControls();
    m.innerHTML = html;
    m.classList.remove('hidden');
  }
  function clearMsg() { $('#pMsg').classList.add('hidden'); $('#pMsg').innerHTML = ''; }
  /* Every playback session owns an epoch. showPlayer / closePlayer bump it;
     async chains (provider races, watchdogs, silent re-extract retries)
     capture it and drop their work on mismatch - a zombie timer from an
     earlier session can never re-mount into a closed or newer player. */
  var playEpoch = 0;
  function showPlayer(title) {
    playEpoch++;
    state.mb = null;
    player().classList.remove('hidden');
    $('#pTitle').textContent = title || '';
    $('#pChip').classList.add('hidden');
    var aud = $('#pAudio');
    if (aud) { aud.classList.add('hidden'); aud.textContent = 'Audio'; }
  }
  function stopVideo() {
    var v = $('#pVideo');
    hideVideoControls();
    if (state.hls) { try { state.hls.destroy(); } catch (e) {} state.hls = null; }
    try { v.pause(); } catch (e) {}
    v.removeAttribute('src'); try { v.load(); } catch (e) {}
    v.onerror = null;
    state.next = null;
    state.subs = null;
    state.audioPicked = false;
    state.naturalEnd = false;
    try { while (v.firstChild) v.removeChild(v.firstChild); } catch (e) {}
  }

  function fmtTime(seconds) {
    var s = Number(seconds);
    if (!isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') + m : m) + ':' + (sec < 10 ? '0' : '') + sec;
  }
  /* Track language priority, enforced everywhere a stream offers choices:
     Hindi first, English second, original/other language only as fallback. */
  var LANG_HI = /(^|[^a-z])(hi|hin|hindi)([^a-z]|$)/i;
  var LANG_EN = /(^|[^a-z])(en|eng|english)([^a-z]|$)/i;
  function langRank(label) {
    var s = String(label || '');
    if (LANG_HI.test(s)) return 0;
    if (LANG_EN.test(s)) return 1;
    return 2;
  }
  function audioTrackLabel(t) {
    t = t || {};
    return [t.name, t.lang, t.language, t.attrs && t.attrs.NAME, t.attrs && t.attrs.LANGUAGE].join(' ');
  }
  /* Multi-audio HLS masters: pick the Hindi rendition, else the English one,
     else leave whatever the manifest itself declared as default. A manual
     pick from the Audio button always wins and is never overridden. */
  function applyAudioPriority(h) {
    try {
      if (!h || !h.audioTracks || h.audioTracks.length < 2 || state.audioPicked) return;
      var hi = -1, en = -1, i;
      for (i = 0; i < h.audioTracks.length; i++) {
        var r = langRank(audioTrackLabel(h.audioTracks[i]));
        if (r === 0 && hi < 0) hi = i;
        else if (r === 1 && en < 0) en = i;
      }
      var pick = hi >= 0 ? hi : en;
      if (pick >= 0 && Number(h.audioTrack) !== pick) h.audioTrack = pick;
    } catch (e) {}
  }
  function syncVideoUI() {
    var v = $('#pVideo');
    var play = $('#pPlay'), seek = $('#pSeek'), time = $('#pTime'), mute = $('#pMute'), vol = $('#pVol');
    if (!v || !play || !seek || !time || !mute || !vol) return;
    var paused = !!v.paused;
    play.textContent = paused ? '\u25B6' : '\u275A\u275A';
    play.setAttribute('aria-label', paused ? 'Play' : 'Pause');
    var dur = isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
    seek.max = String(dur || 1);
    if (!seek.dataset.dragging) seek.value = String(dur ? Math.min(dur, v.currentTime || 0) : 0);
    time.textContent = fmtTime(v.currentTime) + ' / ' + fmtTime(dur);
    var muted = !!v.muted || v.volume === 0;
    mute.textContent = muted ? '\uD83D\uDD07' : '\uD83D\uDD0A';
    mute.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
    if (!vol.dataset.dragging) vol.value = String(v.muted ? 0 : (v.volume || 0));
    /* Next-episode, captions and audio-track buttons only exist when there is
       something behind them - an inert button is worse than no button. A
       playing series (known episode ladder) always drives Prev/Next. */
    var nextB = $('#pNext'), prevB = $('#pPrev'), ccB = $('#pCC'), audB = $('#pAudio');
    var stepN = state.series ? seriesStep(1) : null;
    var stepP = state.series ? seriesStep(-1) : null;
    if (nextB) nextB.classList.toggle('hidden', !(state.series ? !!stepN : !!state.next));
    if (prevB) prevB.classList.toggle('hidden', !(state.series && !!stepP));
    /* Every episodic surface labels the controls with the episode they lead
       to, and shows which one is playing (S1E4 · Ep 4/12) - no guessing. */
    if (nextB) nextB.textContent = 'Ep \u25B6' + (stepN ? ' ' + epTag(stepN) : '');
    if (prevB) prevB.textContent = '\u25C0 Ep' + (stepP ? ' ' + epTag(stepP) : '');
    var chip = $('#pChip');
    if (chip) {
      var sNow = state.series;
      if (sNow) {
        chip.textContent = seriesChip(sNow);
        chip.classList.toggle('hidden', !chip.textContent);
      } else {
        chip.classList.add('hidden');
      }
    }
    if (ccB) {
      var tracks = v.textTracks ? v.textTracks.length : 0;
      ccB.classList.toggle('hidden', !tracks);
      var subOn = false;
      if (v.textTracks) for (var ti = 0; ti < v.textTracks.length; ti++) { if (v.textTracks[ti].mode === 'showing') { subOn = true; break; } }
      ccB.classList.toggle('on', subOn);
    }
    if (audB) {
      var sMb = state.mb;
      if (sMb && sMb.play && sMb.play.audio) {
        var many = sMb.play.audio.length > 1;
        audB.classList.toggle('hidden', !many);
        if (many) {
          var curA = sMb.audio || sMb.play.audio[0];
          audB.textContent = (curA && curA.lanCode) ? String(curA.lanCode).toUpperCase().slice(0, 3) : 'Audio';
          audB.setAttribute('aria-label', 'Audio: ' + mbAudioLabel(curA));
        }
      } else {
        var ats = (state.hls && state.hls.audioTracks) ? state.hls.audioTracks : null;
        audB.classList.toggle('hidden', !(ats && ats.length > 1));
        if (ats && ats.length > 1) audB.textContent = String(Number(state.hls.audioTrack || 0) + 1);
      }
    }
  }
  function showVideoControls() {
    $('#pControls').classList.remove('hidden');
    syncVideoUI();
  }
  function hideVideoControls() {
    var el = $('#pControls');
    if (el) el.classList.add('hidden');
    var m = $('#pMenu');
    if (m) m.classList.add('hidden');
  }
  function toggleFullscreen() {
    try {
      if (document.fullscreenElement) { document.exitFullscreen(); return; }
      /* The WHOLE player goes fullscreen, not just #pStage: the top bar and
         the bottom controls live outside the media stage, so they stay
         visible and clickable in fullscreen too. */
      var pv = $('#playerView') || $('#pStage');
      if (pv && pv.requestFullscreen) {
        var p = pv.requestFullscreen();
        if (p && p.catch) p.catch(function () {});
      }
    } catch (e) {}
  }
  /* ---------------- series navigation (Season/Episode + Prev/Next) ----------------
     ONE engine behind every episodic surface:
       mode 'tmdb'  - TMDB shows/anime/kids: the full season map comes from the
                      /eps backend (every season, every episode, one payload).
       mode 'page'  - scraped series pages (K-Drama / web series / AI drama):
                      the sibling-episode ladder the /extract backend returns.
       mode 'files' - archive.org items that hold several video files.
     The series state SURVIVES stream switches (that is the point: the
     selector and Prev/Next stay on screen while episodes change) and is
     cleared only when the player closes or a non-episodic title starts. */
  function seriesStep(delta) {
    var s = state.series;
    if (!s) return null;
    if ((s.mode === 'tmdb' || s.mode === 'mb') && s.seasons && s.seasons.length) {
      var flat = [];
      s.seasons.forEach(function (sn) { (sn.eps || []).forEach(function (e2) { flat.push({ s: sn.n, e: e2.n }); }); });
      var found = -1;
      for (var i = 0; i < flat.length; i++) { if (flat[i].s === s.season && flat[i].e === s.episode) { found = i; break; } }
      if (found < 0) return null;
      return flat[found + delta] || null;
    }
    if (s.mode === 'page' || s.mode === 'files') {
      var j = (s.idx || 0) + delta;
      return (j >= 0 && j < (s.eps || []).length) ? { idx: j } : null;
    }
    return null;
  }

  /* Short label for a ladder step ('E4' / 'Ep 4') and the "what is playing"
     chip in the top bar. */
  function epTag(st) {
    if (!st) return '';
    if (st.e) return 'E' + st.e;
    var s = state.series;
    if (s && s.eps && s.eps[st.idx] && s.eps[st.idx].n) return 'Ep ' + s.eps[st.idx].n;
    return String((st.idx || 0) + 1);
  }
  function seriesChip(s) {
    if (!s) return '';
    if (s.mode === 'tmdb' || s.mode === 'mb') {
      var cur = (s.seasons || []).filter(function (x) { return x.n === s.season; })[0] || null;
      var total = (cur && cur.eps) ? cur.eps.length : 0;
      var at = 0;
      if (cur && cur.eps) {
        for (var i = 0; i < cur.eps.length; i++) { if (cur.eps[i].n === s.episode) { at = i + 1; break; } }
      }
      return 'S' + s.season + 'E' + s.episode + (total ? ' \u00B7 ' + (at || '?') + '/' + total : '');
    }
    var list = s.eps || [];
    var e2 = list[s.idx || 0];
    if (!e2) return '';
    return (e2.s ? 'S' + e2.s + 'E' + e2.n : 'Ep ' + e2.n) + (list.length > 1 ? ' \u00B7 ' + ((s.idx || 0) + 1) + '/' + list.length : '');
  }

  /* Position of a page inside a ladder: an EXACT step first (the query counts,
     so '?ep=3' is not '?ep=2'), then a scheme/noise-insensitive match for the
     ladders whose steps differ only by path; 0 when it is not listed. */
  function ladderIdx(ladder, url) {
    var L = ladder || [];
    var want = epKey(url), soft = normPage(url), i;
    if (want) for (i = 0; i < L.length; i++) { if (epKey(L[i].url) === want) return i; }
    for (i = 0; i < L.length; i++) { if (normPage(L[i].url) === soft) return i; }
    return 0;
  }

  /* The extractor can mark the episode its page represents (the AI lane's
     direct-MP4 ladder): the marker wins over URL matching, which can never
     match a page URL to a direct file URL. */
  function ladderStart(list, pageUrl) {
    for (var i = 0; i < (list || []).length; i++) { if (list[i] && list[i].cur) return i; }
    return ladderIdx(list, pageUrl);
  }

  /* Does the card that is about to play belong to the ladder already on
     screen? Identity is the card group's key, with a URL-membership fallback
     for items that lost the annotation while jumping (base clones). A stream
     that BELONGS to the playing ladder must never clear or replace it. */
  function ladderOwns(it) {
    var s = state.series;
    if (!s || s.mode !== 'page' || !s.own) return false;
    var g = it && it.__grp;
    if (g && g.key === s.own) return true;
    var u = it && (it.page || it.url);
    var exact = epKey(u);
    if (exact && (s.eps || []).some(function (e2) { return epKey(e2.url) === exact; })) return true;
    var soft = normPage(u);
    if (!soft) return false;
    return (s.eps || []).some(function (e2) { return normPage(e2.url) === soft; });
  }

  /* A card list that arrived pre-grouped (attachEpisodeGroups) seeds the SAME
     page-mode engine a backend ladder does: the Season/Episode selector and
     Prev/Next Ep are live from the first frame, before any resolver answers. */
  function seedPageSeries(it) {
    var g = it && it.__grp;
    if (!g || !g.ladder || g.ladder.length < 2) return false;
    var s = state.series;
    if (s && s.mode === 'page' && s.own === g.key) {
      /* Already the playing show: refresh the index, keep the richer ladder. */
      s.idx = ladderIdx(s.eps, it.page || it.url);
      return true;
    }
    state.series = {
      mode: 'page',
      own: g.key,
      title: g.title || it.t || '',
      base: { t: it.t, kind: it.kind || '', poster: it.poster || '', __grp: g },
      eps: g.ladder.slice(0, 200),
      idx: ladderIdx(g.ladder, it.page || it.url)
    };
    paintSeriesControls();
    return true;
  }

  /* Backend episodes that arrive TOGETHER with the stream (a page's own
     sibling ladder, hentai.tv's episode list) enter the same engine. */
  function seedEpsLadder(it, eps, title) {
    if (!Array.isArray(eps) || eps.length < 2) return false;
    var s = state.series;
    if (s && s.mode === 'page' && ladderOwns(it) && (s.eps || []).length >= eps.length) {
      s.idx = ladderIdx(s.eps, it.page || it.url);
      paintSeriesControls();
      return true;
    }
    var ladder = eps.map(function (e2) {
      return { n: Number(e2.n) || 0, s: Number(e2.s) || 0, url: String(e2.url || ''), t: String(e2.t || '') };
    }).filter(function (e2) { return !!e2.url; });
    if (ladder.length < 2) return false;
    var g = it && it.__grp;
    state.series = {
      mode: 'page',
      own: (g && g.key) || ('u:' + normPage(it && (it.page || it.url))),
      title: title || (g && g.title) || (it && it.t) || '',
      base: { t: it.t, kind: it.kind || '', poster: it.poster || '' },
      eps: ladder.slice(0, 200),
      idx: ladderStart(ladder, it.page || it.url)
    };
    paintSeriesControls();
    return true;
  }

  /* ---------------- custom Web Series (scraped multi-video pages) ----------------
     Cards from the Desi web-series providers (the XMaal Web Series tab rows)
     arrive tagged isSeries + type:'tv'. Their OWN page holds the parts ("8
     Videos" / "2 Videos" on the card): srv2.js scrapes them and hands the
     player an explicit episodes array - [{ ep, title, url }, ...] - and the
     real browser session can read the page itself when Node cannot reach the
     mirror. Both routes feed the SAME season-map below, so a custom series
     behaves exactly like a TMDB show: dropdown + Prev/Next, nothing else. */
  function isSeriesCard(it) {
    if (!it) return false;
    return it.isSeries === true || it.type === 'tv' || (Number(it.parts) || 0) >= 2;
  }
  function isDirectUrl(u) { return /\.(?:mp4|webm|m4v|m3u8)(?:[?#]|$)/i.test(String(u || '')); }
  /* Scraped part titles carry the show name ('Aadhi Gharwali - Episode 2');
     the selector already prints 'Ep 2', so only the part descriptor is kept. */
  function partLabel(title) {
    var t = String(title || '').trim();
    var m = t.match(/(?:^|[-–—:|]\s*)((?:episode|ep|part|pt|video|vid|vol(?:ume)?)\s*\d{1,4})\s*$/i);
    return (m && t.length > m[1].length + 2) ? m[1] : t;
  }
  /* Normalize BOTH ladder shapes into the internal one: `episodes` is the
     explicit [{ ep, title, url }] array the Web Series scrapers send, `eps` is
     the internal sibling ladder [{ n, s, url, t }]. Either one is enough. */
  function epsToLadder(episodes, eps) {
    var src = [], out = [], seen = {};
    if (Array.isArray(episodes) && episodes.length) {
      src = episodes.map(function (e2, i) {
        var n = Number(e2 && e2.ep);
        return { n: n > 0 ? n : (i + 1), s: Number(e2 && e2.s) || 0,
                 url: String((e2 && e2.url) || ''), t: partLabel(e2 && e2.title),
                 d: (e2 && e2.direct) ? 1 : 0, cur: (e2 && e2.cur) ? 1 : 0 };
      });
    } else if (Array.isArray(eps) && eps.length) {
      src = eps.map(function (e2, i) {
        return { n: Number(e2 && e2.n) || (i + 1), s: Number(e2 && e2.s) || 0,
                 url: String((e2 && e2.url) || ''), t: partLabel(e2 && e2.t),
                 d: (e2 && e2.d) ? 1 : 0, cur: (e2 && e2.cur) ? 1 : 0 };
      });
    }
    src.forEach(function (e2) {
      if (!e2.url || !/^https?:/i.test(e2.url)) return;
      var k = e2.url.replace(/#.*$/, '').toLowerCase();
      if (seen[k]) return;
      seen[k] = 1;
      if (!e2.d && isDirectUrl(e2.url)) e2.d = 1;
      out.push(e2);
    });
    return out;
  }
  /* Install a page ladder for this card. An EMPTY ladder still installs a
     single-entry placeholder (the card IS part one): that is how a series card
     shows its Episode UI immediately, while the parts are still being read. */
  function setSeriesLadder(it, ladder, provisional) {
    if (!it) return false;
    var list = (ladder || []).filter(function (e2) { return e2 && e2.url; });
    if (!list.length) {
      var pg0 = String(it.page || it.url || '');
      if (!pg0) return false;
      var ep0 = Number(it.ep) || 1;
      list = [{ n: ep0, s: 0, url: pg0, t: String(it.t || ''), d: isDirectUrl(pg0) ? 1 : 0 }];
      provisional = true;
    }
    /* A series catalogue card is normally its own landing page, which IS
       Episode 1. When a scraped ladder starts at a later part (sites often
       omit the landing link from the numbered grid), put Episode 1 back
       instead of silently starting the show at Episode 2. An explicitly
       picked episode (already on screen) is never rewritten. */
    var base0 = String(it.page || it.url || '');
    if ((!it.__picked || Number(it.__pickN) === 1) && list.length && isSeriesCard(it) && base0 && !list.some(function (x) { return Number(x.n) === 1; })) {
      var baseKey0 = normPage(base0);
      if (baseKey0 && !list.some(function (x) { return normPage(x.url) === baseKey0; })) {
        list.unshift({ n: 1, s: 0, url: base0, t: '', d: isDirectUrl(base0) ? 1 : 0 });
      }
    }
    var g0 = it.__grp;
    var b0 = { t: it.t, kind: it.kind || '', poster: it.poster || '', page: it.page || it.url || '' };
    /* A grouped card keeps its group identity in the ladder base, so a later
       jump still proves it belongs to this ladder. */
    if (g0) b0.__grp = g0;
    state.series = {
      mode: 'page',
      own: (g0 && g0.key) || ('u:' + normPage(it.page || it.url)),
      title: (g0 && g0.title) || it.t || '',
      base: b0,
      eps: list.slice(0, 200),
      idx: ladderStart(list, it.page || it.url),
      provisional: !!provisional
    };
    paintSeriesControls();
    return true;
  }
  /* The backend answer carried no usable ladder (a mirror Node cannot read):
     the real browser session scrapes the series page in the BACKGROUND and
     upgrades the placeholder into the full part list. The stream is already
     playing, so the first frame is never delayed by this fetch. */
  function refreshSeriesParts(it, ep) {
    var pg = String((it && it.page) || '');
    if (!pg || isDirectUrl(pg) || it.__partsRead) return;
    it.__partsRead = 1;
    var sRef = state.series;
    if (!sRef || sRef.mode !== 'page' || !sRef.provisional) return;
    var fetchParts = (it.kind === 'ai' && SC.aiEpisodes)
      ? SC.aiEpisodes(pg)
      : ((it.kind === 'jav' && SC.javEpisodes) ? SC.javEpisodes(pg) : SC.xsEpisodes(pg, it.t));
    fetchParts.then(function (xe) {
      /* Only the ladder THIS card installed may be upgraded: the viewer may
         have switched shows (or episodes) while the fetch was in flight. */
      if (ep !== playEpoch || state.series !== sRef) return;
      var l2 = epsToLadder(xe && xe.episodes, null);
      if (l2.length < 2) return;
      /* Same Episode 1 guarantee as setSeriesLadder(): a scraped parts grid
         that starts at part 2 gets its series landing page back as part 1. */
      if (isSeriesCard(it) && pg && !l2.some(function (x) { return Number(x.n) === 1; })) {
        var pk2 = normPage(pg);
        if (pk2 && !l2.some(function (x) { return normPage(x.url) === pk2; })) {
          l2.unshift({ n: 1, s: 0, url: pg, t: '', d: isDirectUrl(pg) ? 1 : 0 });
        }
      }
      /* Never shrink a real ladder the extractor already installed. */
      if (!sRef.provisional && (sRef.eps || []).length >= l2.length) return;
      sRef.eps = l2;
      sRef.provisional = false;
      sRef.idx = ladderIdx(l2, it.page || it.url);
      paintSeriesControls();
      paintSeriesPicker();
    }).catch(function () {});
  }

  /* ---------------- manual episode start (universal) ----------------
     Every item the app knows to be a SERIES opens its episode menu first and
     NOTHING plays until the viewer clicks an entry - even when the ladder has
     exactly one episode, "Episode 1" is listed and must be clicked. The top-bar
     dropdown mirrors the same ladder; the stage menu is the guaranteed explicit
     click target (a one-option <select> never fires onchange). */
  var pickActive = false;
  function paintSeriesPicker() {
    if (!pickActive) return;
    var m = $('#pMsg');
    if (!m) return;
    var s = state.series;
    var list = [], tmdb = !!(s && s.mode === 'tmdb');
    if (tmdb && s.seasons && s.seasons.length) {
      s.seasons.forEach(function (sn) {
        (sn.eps || []).forEach(function (e2) { list.push({ s: sn.n, n: e2.n, t: e2.name || '' }); });
      });
    } else if (s && (s.eps || []).length) {
      list = s.eps.filter(function (e2) { return e2 && e2.url; });
    }
    /* An unanswered ladder is still an explicit menu: Episode 1 is listed and
       the click starts the resolver exactly like a populated one. */
    if (!list.length) list = [{ s: 0, n: 1, t: String((s && s.title) || '') }];
    m.innerHTML = '';
    var head = document.createElement('h2');
    head.textContent = (s && s.title) ? s.title : 'Select an episode';
    m.appendChild(head);
    var sub = document.createElement('p');
    sub.textContent = 'Choose an episode to start playback.';
    m.appendChild(sub);
    var wrap = document.createElement('div');
    wrap.className = 'picklist';
    list.slice(0, 200).forEach(function (e2, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pickbtn';
      b.textContent = tmdb ? ('S' + (e2.s || 1) + 'E' + (e2.n || 1))
                           : ('Episode ' + (e2.n || (i + 1)));
      b.onclick = function () {
        pickActive = false;
        if (tmdb) jumpTmdbEpisode(Number(e2.s || 1) || 1, Number(e2.n) || 1);
        else if (s && s.mode === 'files') jumpFileEpisode(i);
        else jumpPageEpisode(i);
      };
      wrap.appendChild(b);
    });
    m.appendChild(wrap);
    m.classList.remove('hidden');
    hideVideoControls();
  }
  /* Open a page-mode series WITHOUT playing: seed the ladder (provisional when
     the parts are unknown) and show the menu; the real part list upgrades it in
     the background through the exact fetch the playing path used. */
  function pickPageSeries(it) {
    showPlayer(it.t);
    if (!ladderOwns(it)) clearSeries();
    seedPageSeries(it) || setSeriesLadder(it, [], true);
    var s0 = state.series;
    if (s0) s0.base = { t: it.t, kind: it.kind || '', poster: it.poster || '', page: it.page || it.url || '', __grp: it.__grp };
    pickActive = true;
    paintSeriesPicker();
    refreshSeriesParts(it, playEpoch);
  }
  /* Open a TMDB show WITHOUT playing: the season map fills the same menu, and
     a backend that lists one single episode still requires the explicit click. */
  function pickTmdbSeries(c) {
    if (!c || !c.ref) return;
    showPlayer(c.title);
    state.current = c;
    var sn = Number(c.ref.season || 1) || 1, en = Number(c.ref.episode || 1) || 1;
    if (!state.series || state.series.mode !== 'tmdb' || String(state.series.tmdb) !== String(c.ref.tmdb)) {
      state.series = { mode: 'tmdb', tmdb: String(c.ref.tmdb), title: c.title || '', season: sn, episode: en, seasons: [] };
    } else {
      state.series.season = sn;
      state.series.episode = en;
    }
    paintSeriesControls();
    pickActive = true;
    paintSeriesPicker();
    loadSeries(String(c.ref.tmdb), playEpoch);
  }
  /* A ladder step that IS a stream (a page holding every part as its own media
     URL) plays directly - re-extracting a media URL would only fail. */
  function playDirectPart(step, s, i) {
    var url = String((step && step.url) || '');
    if (!url) return;
    var ep0 = playEpoch;
    var isHls = /\.m3u8(?:[?#]|$)/i.test(url);
    var label = ((s && s.title) ? s.title + ' \u00B7 ' : '') + ((step && step.t) || ('Part ' + (i + 1)));
    var ref = '';
    try { ref = new URL((s && s.base && s.base.page) || url).origin + '/'; } catch (e) {}
    var fail = function () { if (ep0 === playEpoch) showUnavailable(label); };
    var twin = function (B, path) {
      return B + path + encodeURIComponent(url) + (ref ? '&ref=' + encodeURIComponent(ref) : '');
    };
    SC.base().then(function (B) {
      if (ep0 !== playEpoch) return;
      /* HLS needs the proxy (referer + CORS); a direct file is fetched by
         Chromium itself (main.js rewrites the Referer) with the /raw twin as
         the silent fallback - the same order the extractor answers with. */
      if (isHls) playStream(twin(B, '/hls?url='), label, { watchdog: 30000, onFail: fail });
      else playStream(url, label, { fallback: twin(B, '/raw?url='), watchdog: 30000, onFail: fail });
    }).catch(function () { if (ep0 === playEpoch) playStream(url, label, { watchdog: 30000, onFail: fail }); });
  }

  /* The Episode/Season widgets plus their caption: whenever a ladder exists
     (even a single-entry one) the widgets are ON SCREEN, so the viewer always
     knows which episode of which show is playing. */
  function paintSeriesControls() {
    var ss = $('#pSeason'), ee = $('#pEp'), lbl = $('#pEpLbl');
    var s = state.series;
    if (!ss || !ee) { syncVideoUI(); return; }
    var setLbl = function (txt) {
      if (!lbl) return;
      if (txt) { lbl.textContent = txt; lbl.classList.remove('hidden'); }
      else lbl.classList.add('hidden');
    };
    if (!s) {
      ss.classList.add('hidden');
      ee.classList.add('hidden');
      setLbl('');
      syncVideoUI();
      return;
    }
    if ((s.mode === 'tmdb' || s.mode === 'mb') && s.seasons && s.seasons.length) {
      if (s.seasons.length > 1) {
        ss.innerHTML = '';
        s.seasons.forEach(function (sn) {
          var o = document.createElement('option');
          o.value = String(sn.n);
          o.textContent = 'S' + sn.n + (sn.name && !/^season\s/i.test(sn.name) ? ' \u00B7 ' + String(sn.name).slice(0, 22) : '');
          ss.appendChild(o);
        });
        ss.value = String(s.season);
        ss.classList.remove('hidden');
      } else { ss.classList.add('hidden'); }
      var cur = s.seasons.filter(function (x) { return x.n === s.season; })[0] || s.seasons[0];
      var eps = (cur && cur.eps) || [];
      ee.innerHTML = '';
      eps.forEach(function (e2) {
        var o = document.createElement('option');
        o.value = String(e2.n);
        o.textContent = 'E' + e2.n + (e2.name ? ' \u00B7 ' + String(e2.name).slice(0, 22) : '');
        ee.appendChild(o);
      });
      ee.value = String(s.episode);
      ee.classList.toggle('hidden', !eps.length);
      setLbl(eps.length ? 'Episodes' : '');
    } else {
      /* page / files ladders: one implicit season, episodes keyed by index */
      ss.classList.add('hidden');
      ee.innerHTML = '';
      (s.eps || []).forEach(function (e2, i2) {
        var o = document.createElement('option');
        o.value = String(i2);
        var lbl2 = e2.s ? ('S' + e2.s + 'E' + e2.n) : ('Ep ' + e2.n);
        o.textContent = lbl2 + (e2.t ? ' \u00B7 ' + String(e2.t).slice(0, 22) : '');
        ee.appendChild(o);
      });
      ee.value = String(s.idx || 0);
      /* A single-item ladder still shows the selector: the label and the
         entry tell the viewer what is playing, they just have nowhere to go. */
      ee.classList.toggle('hidden', !(s.eps && s.eps.length >= 1));
      setLbl((s.eps && s.eps.length) ? 'Episodes' : '');
    }
    syncVideoUI();
  }

  function clearSeries() {
    state.series = null;
    paintSeriesControls();
  }

  /* Page identity for ladder matching: scheme/query/hash and a trailing
     slash never decide whether two episode URLs are the same page. */
  function normPage(u) {
    var s = String(u || '').trim();
    if (!s) return '';
    try { s = new URL(s, 'http://x/').href; } catch (e) {}
    return s.split('#')[0].split('?')[0].replace(/\/+$/, '').toLowerCase();
  }
  /* Full page identity - the QUERY COUNTS. The Desi web-series ladders are
     query-token ladders ('/<slug>/?ep=2', '?ep=3'): their parts share one path,
     so normPage() alone would call every part the same page. */
  function epKey(u) {
    var s = String(u || '').trim();
    if (!s) return '';
    try { s = new URL(s, 'http://x/').href; } catch (e) {}
    return s.split('#')[0].replace(/\/+$/, '').toLowerCase();
  }

  /* Episode change = a clean teardown of the current stream, then the new
     episode enters the SAME pipeline as the first one did. */
  function jumpTmdbEpisode(se, epn) {
    var s = state.series;
    var c = state.current;
    /* The series can outlive a raw container (a page that resolved straight
       into the TMDB race never seeded state.current): synth one from the
       series map so the jump still enters the provider pipeline. */
    if (!c || !c.ref || !c.ref.tmdb) {
      if (!s || s.mode !== 'tmdb') return;
      c = {
        ref: { type: 'tv', tmdb: String(s.tmdb), imdb: null, season: se, episode: epn },
        title: s.title || $('#pTitle').textContent || 'Episode',
        poster: ''
      };
      state.current = c;
    } else if (s && s.mode === 'tmdb' && String(c.ref.tmdb) !== String(s.tmdb)) {
      /* A stale container from a previous title must never hijack the
         jump: the playing series owns the id. */
      c = {
        ref: { type: 'tv', tmdb: String(s.tmdb), imdb: null, season: se, episode: epn },
        title: s.title || c.title || 'Episode',
        poster: c.poster || ''
      };
      state.current = c;
    }
    if (s && s.mode === 'tmdb' && c.ref.type !== 'tv') c.ref.type = 'tv';
    c.ref.season = se;
    c.ref.episode = epn;
    if (s && s.mode === 'tmdb') { s.season = se; s.episode = epn; }
    stopVideo(); stopEmbed();
    playCurrent();
  }

  function jumpPageEpisode(i) {
    var s = state.series;
    if (!s || s.mode !== 'page') return;
    var list = s.eps || [];
    if (i < 0 || i >= list.length) return;
    s.idx = i;
    var step = list[i] || {};
    var it = Object.assign({}, s.base || {}, { page: step.url, __picked: true, __pickN: Number(step.n) || 0 });
    stopVideo(); stopEmbed();
    paintSeriesControls();
    /* A part can be the media FILE itself (a page that holds every part as its
       own stream): play it straight - re-extracting a media URL only fails. */
    if (step.d || isDirectUrl(step.url)) { playDirectPart(step, s, i); return; }
    customPlay(it).catch(function () { showUnavailable(it.t, { retry: function () { customPlay(it); } }); });
  }

  function jumpFileEpisode(i) {
    var s = state.series;
    if (!s || s.mode !== 'files') return;
    var list = s.eps || [];
    if (i < 0 || i >= list.length) return;
    s.idx = i;
    var e2 = list[i];
    var ep0 = playEpoch;
    stopVideo(); stopEmbed();
    paintSeriesControls();
    playStream(e2.url, (s.title || 'Video') + ' \u00B7 ' + (e2.t || ('Part ' + (i + 1))), {
      watchdog: 30000,
      onFail: function () { if (ep0 === playEpoch) showUnavailable(s.title || 'Archive'); }
    });
  }

  /* TMDB season map for the playing show (one cached backend payload). */
  async function loadSeries(tmdbId, ep) {
    try {
      var j = await SC.eps(tmdbId);
      if (ep !== playEpoch) return;
      var s = state.series;
      if (!s || s.mode !== 'tmdb' || String(s.tmdb) !== String(tmdbId)) return;
      if (j && j.ok && Array.isArray(j.seasons) && j.seasons.length) {
        s.seasons = j.seasons.filter(function (x) { return x && x.eps && x.eps.length; });
        paintSeriesControls();
        paintSeriesPicker();
      }
    } catch (e) {}
  }

  function wireVideoControls() {
    var v = $('#pVideo'), seek = $('#pSeek'), vol = $('#pVol');
    if (!v || !seek || !vol) return;
    $('#pPlay').onclick = function () {
      if (v.paused) {
        /* Pressing play on a naturally finished video restarts it - it never
           triggers a re-extract or loads anything else. */
        if (state.naturalEnd) { state.naturalEnd = false; try { v.currentTime = 0; } catch (e) {} }
        var p = v.play();
        if (p && p.catch) p.catch(function () {});
      } else {
        v.pause();
      }
    };
    /* Click on the picture itself toggles play/pause. The control bar is a
       sibling overlay now, so its clicks never reach the video. */
    if (!v.dataset.clickWired) {
      v.dataset.clickWired = '1';
      /* The picture surface owns click (play/pause) and double-click
         (fullscreen) - but ONLY the real picture area. Any click whose
         coordinates fall inside the top bar or the bottom control strip is
         never treated as a media click, so the click-to-pause hitbox can
         never overlap (or steal) a control-bar press. */
      var overBars = function (ev) {
        var els = [$('#pControls'), document.querySelector('.pbar')];
        for (var i = 0; i < els.length; i++) {
          var be = els[i];
          if (!be || be.classList.contains('hidden')) continue;
          var r = be.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) return true;
        }
        return false;
      };
      v.addEventListener('click', function (ev) {
        if (overBars(ev)) return;
        if (v.paused) {
          if (state.naturalEnd) { state.naturalEnd = false; try { v.currentTime = 0; } catch (e) {} }
          var p = v.play(); if (p && p.catch) p.catch(function () {});
        }
        else v.pause();
      });
      v.addEventListener('dblclick', function (ev) { if (!overBars(ev)) toggleFullscreen(); });
    }
    $('#pMute').onclick = function () {
      v.muted = !v.muted;
      if (!v.muted && v.volume === 0) v.volume = 1;
      syncVideoUI();
    };
    $('#pBack10').onclick = function () {
      try { v.currentTime = Math.max(0, (v.currentTime || 0) - 10); syncVideoUI(); } catch (e) {}
    };
    $('#pFwd10').onclick = function () {
      try {
        var nt = (v.currentTime || 0) + 10, d = isFinite(v.duration) ? v.duration : 0;
        v.currentTime = d > 0 ? Math.min(d, nt) : nt;
        syncVideoUI();
      } catch (e) {}
    };
    /* Prev/Next Ep: a playing series (known episode ladder) always drives
       the buttons through the SAME pipeline the episode came from; the
       scraped single sibling link (state.next) stays as fallback. */
    var seriesGo = function (delta) {
      var s = state.series, st = seriesStep(delta);
      if (!s || !st) return false;
      if (s.mode === 'tmdb') jumpTmdbEpisode(st.s, st.e);
      else if (s.mode === 'mb') jumpMbEpisode(st.s, st.e);
      else if (s.mode === 'files') jumpFileEpisode(st.idx);
      else jumpPageEpisode(st.idx);
      return true;
    };
    $('#pPrev').onclick = function () { seriesGo(-1); };
    $('#pNext').onclick = function () {
      if (seriesGo(1)) return;
      var nx = state.next;
      if (!nx || !nx.url) return;
      customPlay({ t: nx.title || 'Next episode', page: nx.url, kind: nx.kind || '', __picked: true });
    };
    /* Season / Episode selector: both listboxes are rebuilt by
       paintSeriesControls and drive the exact same jumps as Prev/Next. */
    var pss = $('#pSeason'), pee = $('#pEp');
    if (pss) pss.onchange = function () {
      var s = state.series;
      if (!s || (s.mode !== 'tmdb' && s.mode !== 'mb') || !(s.seasons || []).length) return;
      var se2 = Number(pss.value) || 1;
      var cur2 = s.seasons.filter(function (x) { return x.n === se2; })[0] || s.seasons[0];
      var ep2 = (cur2 && cur2.eps && cur2.eps[0] && cur2.eps[0].n) || 1;
      if (s.mode === 'mb') jumpMbEpisode(se2, ep2);
      else jumpTmdbEpisode(se2, ep2);
    };
    if (pee) pee.onchange = function () {
      var s = state.series;
      if (!s) return;
      var val = Number(pee.value);
      if (s.mode === 'tmdb') jumpTmdbEpisode(s.season, val || 1);
      else if (s.mode === 'mb') jumpMbEpisode(s.season, val || 1);
      else if (s.mode === 'files') jumpFileEpisode(val || 0);
      else jumpPageEpisode(val || 0);
    };
    /* Captions: cycle Off -> track 1 -> track 2 -> ... -> Off. */
    $('#pCC').onclick = function () {
      var tts = v.textTracks;
      if (!tts || !tts.length) return;
      var cur = -1, i;
      for (i = 0; i < tts.length; i++) { if (tts[i].mode === 'showing') { cur = i; break; } }
      for (i = 0; i < tts.length; i++) tts[i].mode = 'disabled';
      if (cur + 1 < tts.length) tts[cur + 1].mode = 'showing';
      syncVideoUI();
    };
    /* Multi-language HLS masters expose their audio renditions through the
       hls.js instance - cycle them without leaving the native player. */
    $('#pAudio').onclick = function () {
      /* SuperBox titles expose real dub tracks (separate subject IDs). Open
         the same popover the native app uses instead of blind-cycling. */
      if (state.mb && state.mb.play && state.mb.play.audio && state.mb.play.audio.length > 1) {
        buildMenu();
        menu.classList.remove('hidden');
        return;
      }
      var h = state.hls;
      if (!h || !h.audioTracks || h.audioTracks.length < 2) return;
      /* A manual pick is final for this session: the Hindi priority engine
         must never yank the track back under the user's finger. */
      state.audioPicked = true;
      h.audioTrack = (Number(h.audioTrack || 0) + 1) % h.audioTracks.length;
      syncVideoUI();
    };
    /* Settings: stream quality (HLS levels) plus playback speed. Rebuilt on
       every open so it always mirrors the live session. */
    var menu = $('#pMenu');
    function menuRow(label, sel, fn) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'mi' + (sel ? ' sel' : '');
      b.textContent = label;
      b.onclick = function () { try { fn(); } catch (e) {} buildMenu(); };
      return b;
    }
    function buildMenu() {
      if (!menu) return;
      menu.innerHTML = '';
      var sMb = state.mb;
      if (sMb && sMb.play && sMb.play.qualities && sMb.play.qualities.length) {
        var tq = document.createElement('div'); tq.className = 'mt'; tq.textContent = 'Quality'; menu.appendChild(tq);
        var curQ = sMb.quality;
        sMb.play.qualities.slice().sort(function (a, b) { return (Number(b.height) || 0) - (Number(a.height) || 0); }).forEach(function (q) {
          var selQ = curQ && q.id === curQ.id;
          menu.appendChild(menuRow(mbQualityLabel(q) + (Number(q.height) >= 1080 ? ' \u00B7 HD' : ''), selQ, function () { mbSwitchQuality(q); }));
        });
      }
      if (sMb && sMb.play && sMb.play.audio && sMb.play.audio.length > 1) {
        var ta = document.createElement('div'); ta.className = 'mt'; ta.textContent = 'Audio'; menu.appendChild(ta);
        sMb.play.audio.forEach(function (a) {
          var selA = sMb.audio && String(sMb.audio.subjectId) === String(a.subjectId);
          menu.appendChild(menuRow(mbAudioLabel(a), selA, function () { mbSwitchAudio(a); }));
        });
      }
      var tts = v.textTracks;
      if (tts && tts.length) {
        var ts = document.createElement('div'); ts.className = 'mt'; ts.textContent = 'Subtitles'; menu.appendChild(ts);
        var anyOn = false;
        for (var si = 0; si < tts.length; si++) if (tts[si].mode === 'showing') anyOn = true;
        var setSubs = function (idx) {
          for (var k = 0; k < tts.length; k++) tts[k].mode = (k === idx ? 'showing' : 'disabled');
          syncVideoUI();
        };
        menu.appendChild(menuRow('Off', !anyOn, function () { setSubs(-1); }));
        for (var tj = 0; tj < tts.length; tj++) {
          (function (idx) {
            var lab = tts[idx].label || tts[idx].language || ('Track ' + (idx + 1));
            menu.appendChild(menuRow(lab, tts[idx].mode === 'showing', function () { setSubs(idx); }));
          })(tj);
        }
      }
      var h = state.hls;
      if (h && h.levels && h.levels.length) {
        var t1 = document.createElement('div'); t1.className = 'mt'; t1.textContent = 'Quality'; menu.appendChild(t1);
        var man = h.autoLevelEnabled === false ? h.currentLevel : -1;
        menu.appendChild(menuRow('Auto', man < 0, function () { h.currentLevel = -1; }));
        h.levels.forEach(function (lv, i) {
          menu.appendChild(menuRow(lv.height ? lv.height + 'p' : ('Level ' + (i + 1)), man === i, function () { h.currentLevel = i; }));
        });
      }
      var t2 = document.createElement('div'); t2.className = 'mt'; t2.textContent = 'Speed'; menu.appendChild(t2);
      [0.5, 0.75, 1, 1.25, 1.5, 2].forEach(function (sp) {
        menu.appendChild(menuRow(sp === 1 ? 'Normal' : sp + '\u00D7', Math.abs((v.playbackRate || 1) - sp) < 0.01, function () { v.playbackRate = sp; }));
      });
    }
    if (menu && !menu.dataset.wired) {
      menu.dataset.wired = '1';
      document.addEventListener('click', function (e) {
        if (menu.classList.contains('hidden')) return;
        if (menu.contains(e.target) || e.target === $('#pSet')) return;
        menu.classList.add('hidden');
      });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') menu.classList.add('hidden'); });
    }
    $('#pSet').onclick = function () {
      if (!menu) return;
      if (menu.classList.contains('hidden')) { buildMenu(); menu.classList.remove('hidden'); }
      else menu.classList.add('hidden');
    };
    /* The control bars swallow their own input events: a bar or button press
       can never bubble into the page as a media click-to-toggle (or any other
       delegated handler). The settings popover keeps its click-away close. */
    [$('.pbar'), $('#pControls')].forEach(function (bar) {
      if (!bar || bar.dataset.eatWired) return;
      bar.dataset.eatWired = '1';
      ['click', 'mousedown', 'pointerdown', 'dblclick'].forEach(function (name) {
        bar.addEventListener(name, function (e) {
          e.stopPropagation();
          if (name === 'click' && menu && !menu.classList.contains('hidden') &&
              !menu.contains(e.target) && e.target !== $('#pSet')) menu.classList.add('hidden');
        });
      });
    });
    seek.oninput = function () {
      var d = isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
      if (d) { try { v.currentTime = Math.max(0, Math.min(d, Number(seek.value))); } catch (e) {} }
    };
    vol.oninput = function () {
      v.volume = Math.max(0, Math.min(1, Number(vol.value)));
      v.muted = v.volume === 0;
      syncVideoUI();
    };
    function dragOn(el) {
      el.addEventListener('pointerdown', function () { el.dataset.dragging = '1'; });
    }
    function dragOff() {
      delete seek.dataset.dragging;
      delete vol.dataset.dragging;
      syncVideoUI();
    }
    dragOn(seek); dragOn(vol);
    window.addEventListener('pointerup', dragOff);
    window.addEventListener('pointercancel', dragOff);
    /* 'ended' is deliberately a pure UI refresh plus a marker that the session
       finished NATURALLY: no error handler after this moment may mistake the
       stream for a dead source. This player NEVER chain-loads a next episode,
       next channel, or recommendation on its own - advancing is always the
       user's call, only the Next button does that. */
    v.addEventListener('ended', function () { state.naturalEnd = true; syncVideoUI(); });
    ['play', 'pause', 'timeupdate', 'durationchange', 'loadedmetadata', 'volumechange', 'seeking', 'seeked'].forEach(function (name) {
      v.addEventListener(name, syncVideoUI);
    });
    $('#pFs').onclick = toggleFullscreen;
    $('#pFull').onclick = toggleFullscreen;
    syncVideoUI();
  }
  /* Reuse one iframe for every provider. Replacing a live cross-process
     player node makes Chromium terminate its renderer abruptly (the terminal
     logs "bad IPC message"); a normal src navigation is the graceful path.
     frameEpoch invalidates old autoplay timers that still hold the node. */
  var frameEpoch = 0;
  function resetFrame() {
    var f = $('#pFrame') || document.querySelector('.pframe iframe');
    if (!f) {
      f = document.createElement('iframe');
      f.id = 'pFrame';
      f.className = 'hidden';
      (document.querySelector('.pframe') || player()).appendChild(f);
    }
    try { f.onload = null; f.onerror = null; } catch (e) {}
    return f;
  }
  function stopEmbed() {
    state.embedStuck = null;
    clearInterval(state.cfChk);
    state.cfChk = null;
    clearTimeout(state.stallT);
    state.stallT = null;
    /* The mount watchdog dies with the mount: a torn-down embed can never
       fire a late "stuck" rotation into a newer surface. */
    clearTimeout(embedTimer);
    frameEpoch++;
    try {
      var f = $('#pFrame');
      if (f) { f.onload = null; f.onerror = null; f.classList.add('hidden'); f.src = 'about:blank'; }
    } catch (e) {}
  }
  function closePlayer() {
    playEpoch++;
    stopVideo(); stopEmbed();
    try { if (document.fullscreenElement) document.exitFullscreen(); } catch (e) {}
    $('#pVideo').classList.add('hidden');
    clearMsg();
    player().classList.add('hidden');
    state.current = null;
    state.mb = null;
    clearSeries();
  }

  function playStream(url, title, opts) {
    opts = opts || {};
    autoVpnForUrl(url);
    var ep = playEpoch;
    stopEmbed();
    var v = $('#pVideo');
    v.classList.remove('hidden');
    $('#pFrame').classList.add('hidden');
    stopVideo();
    clearMsg();
    showVideoControls();
    /* The play URL is the LOCAL proxy twin (/hls?url=<encoded .m3u8>): its
       encoded "?" defeats a naive extension test, and a miss makes Chromium
       swallow a multi-audio master in native HLS mode and stall forever.
       Every /hls twin is HLS, so detect the route itself. */
    var hls = /^https?:\/\/127\.0\.0\.1:\d+\/hls\?/i.test(url) || /\.m3u8(\?|#|$)/i.test(url);
    /* Captions need CORS on the local twin (always granted); direct upstream
       files keep their plain no-CORS media fetch. */
    var local = /^https?:\/\/127\.0\.0\.1:\d+\//i.test(url);
    if (local) v.setAttribute('crossorigin', 'anonymous'); else v.removeAttribute('crossorigin');
    state.next = opts.next || null;
    state.subs = (opts.subs && opts.subs.length) ? opts.subs : null;
    state.audioPicked = false;
    state.naturalEnd = false;
    var dead = false, wd = null, started = false;
    /* Event listeners live on ONE persistent <video>. Every playStream call
       used to add three more anonymous listeners that were never removed -
       after a viewing session that was dozens of live handlers. Each new
       source now detaches the previous source's handlers first. */
    if (typeof v.__sbClean === 'function') { try { v.__sbClean(); } catch (e) {} }
    var vListeners = [];
    var onV = function (name, fn) { v.addEventListener(name, fn); vListeners.push([name, fn]); };
    v.__sbClean = function () {
      for (var li = 0; li < vListeners.length; li++) { try { v.removeEventListener(vListeners[li][0], vListeners[li][1]); } catch (e) {} }
      vListeners = [];
    };
    /* Frames successfully rendered (or a buffer at readyState >= 2) are a
       hard "do not rotate" signal. This survives buffering stalls: once a
       viewer has seen the stream, a watchdog may never replace it. */
    var markStarted = function () {
      if (v.readyState >= 2 || (!v.paused && v.currentTime > 0.2)) started = true;
    };
    var lastProgress = Date.now(), began = Date.now();
    var noteProgress = function () { lastProgress = Date.now(); markStarted(); };
    onV('playing', markStarted);
    onV('loadeddata', markStarted);
    onV('timeupdate', markStarted);
    onV('progress', noteProgress);
    onV('loadedmetadata', noteProgress);
    onV('canplay', noteProgress);
    var mediaHealthy = function () {
      return started || v.readyState >= 2 || (!v.paused && v.currentTime > 0.2);
    };
    var fail = function (fatal) {
      if (dead) return;
      /* A newer session owns the player: this chain is a zombie. */
      if (ep !== playEpoch) return;
      /* Only a genuine fatal media error may interrupt a stream that already
         produced frames. Timeouts/watchdogs stay inert while healthy. */
      if (!fatal && mediaHealthy()) return;
      dead = true;
      clearTimeout(wd);
      /* Natural end-of-stream: a late fatal (VOD playlist end, final-fragment
         append error) must NEVER trigger a silent re-extract, an auto reload
         or an "unavailable" screen. The finished session simply stays put -
         pressing play again restarts it from the beginning. */
      if (state.naturalEnd || v.ended || (isFinite(v.duration) && v.duration > 5 && v.currentTime >= v.duration - 1.5)) { syncVideoUI(); return; }
      /* A slow/blocked upstream gets ONE silent retry through the local
         twin before the user ever sees an error. Expiring signed streams
         (Eporner...) get ONE silent re-extract via opts.onFail instead. */
      if (opts.fallback) { var f2 = opts.fallback; var on2 = opts.onFail; opts.fallback = ''; opts.onFail = null; playStream(f2, title, { watchdog: 45000, onFail: on2 }); return; }
      if (opts.onFail) { var fn = opts.onFail; opts.onFail = null; try { fn(); } catch (e) {} return; }
      showUnavailable(title || $('#pTitle').textContent, { retry: function () { playStream(url, title, opts); } });
    };
    if (hls && window.Hls && window.Hls.isSupported()) {
      var h = new window.Hls({
        maxBufferLength: 60,
        manifestLoadingTimeOut: 45000,
        levelLoadingTimeOut: 45000,
        fragLoadingTimeOut: 45000,
        enableWorker: false
      });
      state.hls = h;
      h.on(window.Hls.Events.ERROR, function (_ev, data) { if (data && data.fatal) fail(true); });
      /* Manifest/level/fragment traffic counts as progress: a slow HLS source
         keeps its full grace window while a socket that answers nothing is
         detected and rotated. */
      h.on(window.Hls.Events.MANIFEST_LOADED, noteProgress);
      h.on(window.Hls.Events.LEVEL_LOADED, noteProgress);
      h.on(window.Hls.Events.FRAG_LOADED, noteProgress);
      h.on(window.Hls.Events.FRAG_BUFFERED, noteProgress);
      /* Levels / renditions only exist after the manifest: refresh the
         settings menu, then force the Hindi -> English -> original
         language priority onto the audio rendition. */
      h.on(window.Hls.Events.MANIFEST_PARSED, function () { applyAudioPriority(h); syncVideoUI(); });
      h.on(window.Hls.Events.AUDIO_TRACKS_UPDATED, function () { applyAudioPriority(h); syncVideoUI(); });
      h.on(window.Hls.Events.SUBTITLE_TRACKS_UPDATED, syncVideoUI);
      h.loadSource(url); h.attachMedia(v);
      v.play().catch(function () {});
    } else {
      v.onerror = function () { fail(true); };
      v.src = url;
      v.play().catch(function () {});
    }
    /* Captions ride on the same video element as plain text tracks, ordered
       Hindi -> English -> original so the CC button lands on Hindi first. */
    try {
      while (v.firstChild) v.removeChild(v.firstChild);
      var subs = (state.subs || []).slice().sort(function (a, b) { return langRank(a && a.lang) - langRank(b && b.lang); });
      subs.forEach(function (s) {
        var tr = document.createElement('track');
        tr.kind = 'subtitles';
        tr.label = s.lang || 'Subtitle';
        tr.srclang = String(s.lang || 'en').slice(0, 2).toLowerCase();
        tr.src = s.url;
        v.appendChild(tr);
      });
    } catch (e) {}
    /* Native-app behaviour when switching quality or audio: resume the exact
       timestamp instead of restarting the title. */
    if (opts.startAt > 0) {
      var at = Number(opts.startAt) || 0;
      var seekOnce = function () {
        if (ep !== playEpoch) return;
        try { if (!isFinite(v.duration) || at < v.duration - 1) v.currentTime = at; } catch (e) {}
        v.removeEventListener('loadedmetadata', seekOnce);
      };
      v.addEventListener('loadedmetadata', seekOnce);
      if (v.readyState >= 1) seekOnce();
    }
    syncVideoUI();
    /* Dead-source watchdog with a strict state guard. A player that already
       produced frames/buffer is healthy forever; a source that never produced
       a first frame is rotated after 15s of ZERO network progress (a dead
       socket/CDN), and in every case by the explicit grace ceiling. The old
       implementation waited a flat 45s, which is exactly the "infinite
       loading" the app used to show when an upstream connection stalled. */
    var stallTick = function () {
      if (dead || ep !== playEpoch) return;
      if (mediaHealthy()) { wd = setTimeout(stallTick, 5000); return; }
      var now = Date.now();
      if (now - lastProgress > 15000 || now - began > sourceGrace(opts.watchdog || 45000)) { fail(false); return; }
      wd = setTimeout(stallTick, 2000);
    };
    wd = setTimeout(stallTick, 5000);
  }

  var embedTimer = null;
  function playEmbed(url, title, opts) {
    opts = opts || {};
    var ep = playEpoch;
    var fe = ++frameEpoch;
    stopVideo();
    $('#pVideo').classList.add('hidden');
    clearMsg();
    var f = resetFrame();
    f.classList.remove('hidden');
    f.src = url;
    clearTimeout(embedTimer);
    embedTimer = null;
    embMediaT = 0;
    var loaded = false;
    var rotate = function () {
      clearTimeout(embedTimer);
      embedTimer = null;
      clearTimeout(state.stallT);
      state.stallT = null;
      clearInterval(state.cfChk);
      state.cfChk = null;
      state.embedStuck = null;
      if (ep !== playEpoch) return;
      if (typeof opts.onStuck === 'function') { opts.onStuck(); return; }
      showUnavailable(title || $('#pTitle').textContent, {
        retry: function () { playEmbed(url, title, opts); },
        page: opts.page || url
      });
    };
    /* Cross-origin frames cannot be inspected, but their ENHANCER posts a
       __zaiMedia heartbeat. A heartbeat, a same-origin <video> with a frame,
       or a loaded YouTube embed all mean "do not rotate". */
    var mediaHealthy = function () {
      if (embMediaT && Date.now() - embMediaT < 15000) return true;
      if (loaded && /youtube(?:-nocookie)?\.com|youtu\.be/i.test(url)) return true;
      try {
        var d = f.contentDocument;
        if (d) {
          var v = d.querySelector('video');
          if (v && ((!v.paused && v.currentTime > 0.2) || v.readyState >= 2)) return true;
        }
      } catch (e) {}
      return false;
    };
    /* Watchdog only rotates a shell that has never produced media. While
       media is healthy it re-arms itself silently, so buffering or a long
       movie is never mistaken for a dead source. */
    var watchdog = function () {
      embedTimer = null;
      if (ep !== playEpoch || !state.embedStuck) return;
      if (mediaHealthy()) { embedTimer = setTimeout(watchdog, 5000); return; }
      rotate();
    };
    /* The frame itself, or its in-page ENHANCER, may later report the media
       is missing ("We couldnt find that") - keep the hook live after load. */
    state.embedStuck = rotate;
    /* Challenge watchdog: the moment this frame (or a turnstile running
       inside it) starts a Cloudflare verification, swap providers - the
       verification screen must never be what the user sees. */
    var cfT0 = Date.now();
    var cfUrl = url;
    try { var mu = /[?&]url=([^&]+)/.exec(url); if (mu) cfUrl = decodeURIComponent(mu[1]); } catch (e) {}
    clearInterval(state.cfChk);
    state.cfChk = setInterval(function () {
      if (ep !== playEpoch) return;
      if (!cfHit(cfUrl, cfT0)) return;
      clearInterval(state.cfChk); state.cfChk = null;
      if (mediaHealthy()) return;
      state.embedStuck = null;
      if (typeof opts.onCf === 'function') { opts.onCf(); return; }
      rotate();
    }, 1200);
    f.onload = function () { if (ep !== playEpoch || fe !== frameEpoch) return; loaded = true; clearMsg(); nudgePlay(f, fe); };
    embedTimer = setTimeout(watchdog, sourceGrace(opts.watchdog || 45000));
    /* Stall swap: a mounted page that never reports any media (and never says
       it is dead) is a broken shell - rotate only after the 45s grace. */
    clearTimeout(state.stallT);
    state.stallT = null;
    if (opts.stallSwap) {
      state.stallT = setTimeout(function tick() {
        state.stallT = null;
        if (!state.embedStuck || ep !== playEpoch) return;
        if (mediaHealthy()) { state.stallT = setTimeout(tick, 5000); return; }
        rotate();
      }, sourceGrace(opts.stallSwap));
    }
  }

  /* Best-effort autoplay inside a mounted player frame: start a <video> that
     is sitting paused and press the usual big center play buttons. Wrapped in
     try/catch - frames we cannot reach keep their own player UI in charge. */
  function nudgePlay(f, fe) {
    var nudged = false;
    [500, 1400, 2800, 4800, 7200, 10000, 14000].forEach(function (ms) {
      setTimeout(function () {
        if (fe !== frameEpoch) return;
        try {
          var d = f.contentDocument;
          if (!d) return;
          var v = d.querySelector('video');
          if (v && v.paused) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
          if (nudged) return;
          var b = d.querySelector('.vjs-big-play-button, .jw-display-icon-container, .jw-icon-display, [class*="big-play"], [class*="play-btn"], .play-button, button[aria-label*="lay"]');
          if (b) { nudged = true; b.click(); }
        } catch (e) {}
      }, ms);
    });
  }

  function showUnavailable(title, opts) {
    opts = opts || {};
    clearTimeout(embedTimer);
    stopVideo(); stopEmbed();
    $('#pVideo').classList.add('hidden');
    /* The external "Open source page" hatch survives ONLY inside the 18+
       vault (its original escape hatch, untouched). Standard sections never
       hand a stream to an external browser: their providers mount inside
       the app window (#pFrame) instead. */
    var html = '<h2>Playback unavailable</h2><p>' + (opts.message ? esc(String(opts.message)) : 'No working source responded for &ldquo;' + esc(title || 'this title') + '&rdquo; right now.') + '</p><div class="row2">' +
      '<button class="primary" id="pmRetry">Try again</button>' +
      (opts.page && state.section === 'adult' ? '<button id="pmOpen">Open source page</button>' : '') +
      '<button id="pmBack">Back</button></div>';
    stageMsg(html);
    var r = $('#pmRetry');
    if (r) r.onclick = function () { if (opts.retry) opts.retry(); else playCurrent(); };
    var o = $('#pmOpen');
    if (o) o.onclick = function () { try { window.bridge && window.bridge.openExternal(opts.page); } catch (e) {} };
    var b = $('#pmBack');
    if (b) b.onclick = closePlayer;
  }

  function showLoading(text) {
    stageMsg('<div class="spin"></div><p>' + esc(text || 'Starting stream...') + '</p>');
  }

  /* Stage 0 reachability gate: the srv2 backend checks every candidate host
     BEFORE Chromium ever requests it. Dead domains, DNS failures and invalid
     certificates are dropped in Node, so the terminal stays free of
     ERR_NAME_NOT_RESOLVED / ERR_CERT_* noise and a click can never stall on a
     host that no longer exists. Slow hosts get a fast 12s grace before the
     gate drops them. */
  function gateCandidates(B, list) {
    return Promise.all(list.map(function (x) {
      return withTimeout(
        fetch(B + '/probe?url=' + encodeURIComponent(x.url), { cache: 'no-store' }).then(function (r) { return r.json(); }),
        12000
      ).catch(function () { return { reach: false }; });
    })).then(function (facts) {
      var out = [];
      facts.forEach(function (f, i) { if (f && f.reach) out.push({ x: list[i], f: f }); });
      return out;
    });
  }

  function buildUrl(p, ref, s, e) {
    if (ref.tmdb && p.ids.indexOf('tmdb') > -1) { /* ok */ }
    else if (!(ref.imdb && p.ids.indexOf('imdb') > -1)) return '';
    var id = (p.ids.indexOf('tmdb') > -1) ? ref.tmdb : ref.imdb;
    if (!id) return '';
    return (ref.type === 'movie' ? p.m : p.t).replace('{id}', id).replace('{s}', s).replace('{e}', e);
  }

  function markFailed(key, names) {
    if (!state.failed.has(key)) state.failed.set(key, new Set());
    var s = state.failed.get(key);
    names.forEach(function (n) { s.add(n); });
  }

  /* Silent TMDB flow - the user NEVER sees a server list, a scanner or a 429:
     1. Server-side reachability gate drops dead hosts without touching the browser.
     2. Every surviving provider is extracted SERVER-SIDE to a raw stream
        (.mp4/.m3u8) and played in the app's own video surface.
     3. Providers run in a staggered parallel pre-extraction window (three in
        flight, 1.2s apart) and every ok:false rotates instantly; a lone dead
        host costs at most its 30s ceiling and can never stall the queue.
     4. When extraction answers without a raw stream, the provider's own
        player mounts INSIDE the app window (#pFrame) and every dead or
        silent frame rotates to the next provider after its 30s ceiling -
        an external browser is NEVER launched for a stream.
     5. Only when BOTH lanes are exhausted does the clean
        "Stream unavailable" overlay with working Retry / Back appear. */
  async function playTmdb(c) {
    showPlayer(c.title);
    var ep = playEpoch;
    showLoading('Finding fastest stream...');
    var ref = c.ref;
    var key = ref.type + ':' + ref.tmdb + ':' + (ref.season || 1) + ':' + (ref.episode || 1);
    /* The fail counter is per EPISODE key, never per container: jumping to
       another episode restarts the provider race from provider #1 instead
       of instantly landing on the previous episode's failure card. */
    if (c.__key !== key) { c.__key = key; c.__n = 0; }
    c.__n = (c.__n || 0) + 1;
    if (c.__n > 6) { finishTmdbFail(c, key, []); return; }
    /* An episodic TMDB ref switches the player into series mode: the
       Season/Episode selector appears at once (filled the moment /eps
       answers) and Prev/Next drive episode changes through this race. */
    if (ref.type === 'tv') {
      var sr = state.series;
      var sn0 = Number(ref.season || 1) || 1, en0 = Number(ref.episode || 1) || 1;
      /* The series container becomes the live state.current: a page that
         resolved straight into this race (no detail screen) still gets a
         consistent Next/Prev target instead of a stale old container. */
      state.current = c;
      if (!sr || sr.mode !== 'tmdb' || String(sr.tmdb) !== String(ref.tmdb)) {
        state.series = { mode: 'tmdb', tmdb: String(ref.tmdb), title: c.title || '', season: sn0, episode: en0, seasons: [] };
      } else {
        sr.season = sn0;
        sr.episode = en0;
      }
      paintSeriesControls();
      loadSeries(String(ref.tmdb), ep);
      var pt = $('#pTitle');
      if (pt) pt.textContent = (c.title || '') + '  \u00B7  S' + sn0 + 'E' + en0;
    } else if (state.series) {
      clearSeries();
    }

    var failed = state.failed.get(key);
    var list = [];
    (Z.PROVIDERS || []).forEach(function (p) {
      if (failed && failed.has(p.n)) return;
      if (state.cfDead.has(p.n)) return;                  /* challenged here once - never again */
      var u = buildUrl(p, ref, ref.season || 1, ref.episode || 1);
      if (u) list.push({ p: p, url: u });
    });
    if (!list.length) { finishTmdbFail(c, key, []); return; }

    var B = await SC.base();
    if (ep !== playEpoch) return;
    var gated = await gateCandidates(B, list.slice(0, 14));
    if (ep !== playEpoch) return;
    if (!gated.length) { finishTmdbFail(c, key, list); return; }

    /* Native-first with an in-app embed failover. The top candidates run in a
       STAGGERED PARALLEL window (up to three in flight, each starting 1.2s
       apart) so one dead host's 30s timeout can never stall the queue: the
       first provider that yields a raw stream (.mp4/.m3u8) wins on the app's
       own video surface. The moment a candidate answers WITHOUT a raw stream,
       that provider's player is ALSO mounted right here, inside the app
       window (#pFrame iframe) - playback never leaves SuperBox. Every
       dead / challenged / media-less frame rotates to the next provider after
       its 30s ceiling. A late raw-stream win still takes over the surface;
       the app's own card appears only when BOTH lanes are exhausted. */
    var order = gated.slice(0, 6);
    var cursor = 0, active = 0, settled = false;
    var embedQ = gated.map(function (g) { return { n: g.x.p.n, url: g.x.url }; });
    var embedI = 0, embedStarted = false, embedExhausted = false;

    var maybeFinish = function () {
      if (ep !== playEpoch || settled) return;
      if (cursor >= order.length && active === 0 && (embedExhausted || !embedStarted)) {
        settled = true;
        finishTmdbFail(c, key, list);
      }
    };
    var mountNextEmbed = function () {
      if (ep !== playEpoch || settled) return;
      var pick = null;
      while (embedI < embedQ.length) {
        var cand = embedQ[embedI++];
        /* A host that challenged this session once is never re-mounted. */
        if (state.cfDead.has(cand.n)) continue;
        pick = cand;
        break;
      }
      if (!pick) { embedExhausted = true; maybeFinish(); return; }
      embedStarted = true;
      playEmbed(pick.url, c.title, {
        watchdog: 30000,
        stallSwap: 30000,
        onStuck: function () { if (ep === playEpoch) mountNextEmbed(); }
      });
    };
    var startEmbeds = function () {
      if (!embedStarted && !settled && ep === playEpoch) mountNextEmbed();
    };
    var pump = function () {
      if (settled || ep !== playEpoch) return;
      if (cursor >= order.length) { maybeFinish(); return; }
      launch(order[cursor++]);
    };
    var launch = function (item) {
      active++;
      SC.extract(item.x.url, c.title, 45000).then(function (ex) {
        active--;
        if (ep !== playEpoch || settled) return;
        /* A provider that challenged this host once is never revisited. */
        if (ex && ex.cf) state.cfDead.add(item.x.p.n);
        if (ex && ex.ok !== false && (ex.type === 'hls' || ex.type === 'direct')) {
          settled = true;
          /* If the winning stream dies mid-playback, resume BOTH lanes. */
          var again = function () {
            if (ep !== playEpoch) return;
            settled = false;
            if (cursor >= order.length && active === 0 && !embedExhausted) mountNextEmbed();
            pump();
          };
          if (ex.type === 'hls') { playStream(ex.native ? ex.file : (ex.play || ex.file), c.title, { onFail: again, subs: ex.subs || null }); return; }
          playStream(ex.file || ex.play, c.title, { fallback: (ex.play && ex.play !== ex.file) ? ex.play : '', onFail: again, subs: ex.subs || null });
          return;
        }
        /* If extraction found this provider's CLEANEST inner player, mount
           that instead of the provider shell when its turn comes. */
        if (ex && ex.type === 'embed' && ex.embed) {
          embedQ.forEach(function (q) { if (q.n === item.x.p.n) q.url = ex.embed; });
        }
        /* ok:false / embed-only / timeout: rotate the extraction lane AND
           raise the in-app embed lane on the first answer - the user never
           stares at a spinner while the queue drains. */
        startEmbeds();
        pump();
      }).catch(function () {
        active--;
        if (ep === playEpoch && !settled) { startEmbeds(); pump(); }
      });
    };
    pump();
    setTimeout(function () { if (!settled && ep === playEpoch) pump(); }, 1200);
    setTimeout(function () { if (!settled && ep === playEpoch) pump(); }, 2400);
  }

  /* All providers are exhausted: the app answers with its own native
     "Stream unavailable" card. NO YouTube trailer fallback - YouTube lives
     exclusively in the Tube tab and never bleeds into movies, series or
     anime playback. */
  function finishTmdbFail(c, key, list) {
    showUnavailable(c.title, {
      retry: function () { state.failed.delete(key); c.__n = 0; playTmdb(c); },
      page: (list && list[0] && list[0].url) || ''
    });
  }

  /* Archive.org items: resolve the item's raw video FILE via the metadata
     API and play it natively (verifiable, seekable, no third-party player
     chrome). If no raw file can be resolved the app fails natively - the
     site's own embed iframe is never mounted. */
  async function playArchive(id, title) {
    if (!id) { showUnavailable(title || 'Archive'); return; }
    var ep = playEpoch;
    var emb = function () { if (ep !== playEpoch) return; showUnavailable(title || 'Archive'); };
    showLoading('Fetching video...');
    try {
      var r = await fetch('https://archive.org/metadata/' + encodeURIComponent(id), { cache: 'no-store' });
      if (ep !== playEpoch) return;
      var j = await r.json();
      if (ep !== playEpoch) return;
      var files = (j && j.files) || [];
      /* Every playable video file of the item becomes one episode: an item
         holding several files gets the same Season/Episode style selector
         as a series, single-file items play straight. */
      var vids = files
        .filter(function (f) { return /\.(mp4|m4v|ogv|webm)$/i.test(f.name || '') && !/(thumb|sample|preview)/i.test(f.name || ''); })
        .sort(function (a, b) { return (Number(b.size) || 0) - (Number(a.size) || 0); });
      var mp4s = vids.filter(function (f) { return /\.(mp4|m4v)$/i.test(f.name || ''); });
      var use = mp4s.length ? mp4s : vids;
      if (use.length && use[0].name) {
        var eps2 = use.map(function (f, i) {
          return {
            n: i + 1, s: 0,
            t: String(f.name || ('Part ' + (i + 1))).replace(/\.(mp4|m4v|ogv|webm)$/i, ''),
            url: 'https://archive.org/download/' + encodeURIComponent(id) + '/' + encodeURIComponent(f.name).replace(/%2F/gi, '/')
          };
        });
        if (eps2.length > 1) {
          state.series = { mode: 'files', title: title || '', eps: eps2, idx: 0 };
          paintSeriesControls();
        } else if (state.series) {
          clearSeries();
        }
        var t0 = eps2.length > 1 ? ((title || 'Archive') + ' \u00B7 ' + eps2[0].t) : title;
        playStream(eps2[0].url, t0, { watchdog: 30000, onFail: emb });
        return;
      }
    } catch (e) {}
    emb();
  }

  function playCurrent() {
    var c = state.current;
    if (!c) return;
    if (c.ref && c.ref.archive) { playArchive(c.ref.archive, c.title); return; }
    playTmdb(c);
  }

  /* ---------------- custom-library playback ---------------- */
  function unavailable(it) { showUnavailable(it.t, { retry: function () { customPlay(it); } }); }

  /* Dynamic players build the stream in their own JS at request time and
     behave only on their own origin: fetching the raw page through /page
     yields a black shell every time. Extract first; when that fails there is
     nothing left to mount for these hosts. */
  var DYNAMIC_HOST = /(eporner\.|vidlink\.|videasy\.|2embed\.|vidfast\.|vidsrc\.)/i;

  /* Custom libraries have real stream resolvers on the backend. When one of
     them produces no raw stream, the player shows its clean Retry card -
     it NEVER mounts the source site page or a foreign player shell (the old
     black/pink iframe fallback). */
  var CUSTOM_NATIVE = /^(hd|kd|kat|xs|anx)$/;

  /* Hentai.tv -> nhplayer: decode the signed mp4 in the renderer, play it
     natively; the local /raw twin (carrying the full signed raw string) and
     the source's own player/watch pages are silent fallbacks. */
  async function htvPlay(it) {
    if (!ladderOwns(it)) clearSeries();
    var ep = playEpoch;
    var s = null;
    try { s = await SC.nhStream(it.page); } catch (e) {}
    if (ep !== playEpoch) return;
    var embV = function () { if (ep !== playEpoch) return; if (it.page) playEmbed(it.page, it.t, { watchdog: 22000 }); else unavailable(it); };
    var embP = function () {
      if (ep !== playEpoch) return;
      if (s && s.playerUrl) playEmbed(s.playerUrl, it.t, { watchdog: 26000, onStuck: embV });
      else embV();
    };
    /* hentai.tv episodes are cards, not pages: the ladder came with the card
       list, so the selector is live whether the mp4 resolves or the player
       page is the surface that ends up mounting. */
    seedPageSeries(it) || seedEpsLadder(it, s && s.eps, s && s.title);
    if (s && s.url) {
      var B = await SC.base();
      if (ep !== playEpoch) return;
      var prox = B + '/raw?url=' + encodeURIComponent(s.raw) + '&ref=' + encodeURIComponent('https://nhplayer.com/');
      playStream(s.url, it.t, { watchdog: 15000, fallback: prox, onFail: embP });
      return;
    }
    embV();
  }

  /* Tube: a real progressive MP4/HLS from the local resolver plays in the
     native surface with zero YouTube chrome and zero ads. If no stream can be
     resolved, the isolated no-cookie embed is the only fallback - the app
     never mounts the full YouTube site. */
  async function ytPlay(it) {
    showPlayer(it.t);
    clearSeries();
    var ep = playEpoch;
    showLoading('Starting YouTube...');
    var st = null;
    try { st = await SC.ytStream(it.vid || it.id); } catch (e) { st = null; }
    if (ep !== playEpoch) return;
    var embed = function () {
      if (ep !== playEpoch) return;
      var id = it.vid || it.id;
      if (!id) { unavailable(it); return; }
      playEmbed('https://www.youtube-nocookie.com/embed/' + encodeURIComponent(id) + '?autoplay=1&rel=0&modestbranding=1&playsinline=1&iv_load_policy=3', it.t, { watchdog: 30000, stallSwap: 30000 });
    };
    if (st && st.ok !== false && st.type === 'embed' && st.url) {
      playEmbed(st.url, it.t, { watchdog: 30000, stallSwap: 30000 });
      return;
    }
    if (st && st.ok !== false && st.url) {
      var src = st.type === 'hls' ? (st.proxy || st.url) : st.url;
      var fb = st.type === 'hls' ? '' : (st.proxy || '');
      playStream(src, it.t, { watchdog: 30000, fallback: fb, onFail: embed });
      return;
    }
    embed();
  }

  async function customPlay(it, re) {
    showPlayer(it.t);
    var ep = playEpoch;
    showLoading('Preparing stream...');
    /* Card-annotated ladders (web-series / K-Drama / anime / JAV card lists)
       seed the engine before extraction, so the Season/Episode selector and
       Prev/Next are live while the stream is still resolving. A card that
       belongs to the playing ladder never touches it; anything else that
       cannot seed one starts clean. */
    if (it.kind !== 'mv' && it.kind !== 'htv' && !ladderOwns(it) && !seedPageSeries(it)) clearSeries();
    /* A card explicitly tagged as a series (the Web Series tab cards carry
       isSeries + type:'tv', and any card badged "8 Videos" is detected the
       same way) gets the Episode UI ON SCREEN immediately: the "Episodes"
       label and a placeholder entry that the scraped part list replaces the
       moment it arrives. */
    if (it.kind !== 'mv' && it.kind !== 'htv' && isSeriesCard(it) && !ladderOwns(it)) setSeriesLadder(it, [], true);
    if (it.kind === 'htv' && it.page) return htvPlay(it);
    /* Standard sections wait up to 30s for a raw stream before the retry
       ladder moves on; the 18+ vault keeps its original extraction cap. */
    var adult = state.section === 'adult';
    var ex = null;
    try { ex = await SC.extract(it.page || it.url, it.t, 45000); } catch (e) { ex = null; }
    if (ep !== playEpoch) return;
    /* Expiring signed URLs (Eporner) may fail minutes after extraction -
       a single silent re-extract hands the player a fresh signature. */
    var refail = function () {
      if (ep !== playEpoch) return;
      if (re) { showUnavailable(it.t, { retry: function () { customPlay(it); } }); return; }
      setTimeout(function () { if (ep === playEpoch) customPlay(it, true); }, 500);
    };
    /* Cloudflare blocked this source: never mount a challenge - the provider
       is treated as failed and rotated silently. */
    if (ex && ex.cf) { unavailable(it); return; }
    /* HindiDrama / KDramasMaza / custom-library titles are resolved
       server-side to raw streams. If extraction produced nothing, retry once
       and fail cleanly - the site page or a foreign player shell is NEVER
       mounted as fallback. */
    if (CUSTOM_NATIVE.test(it.kind || '') && (!ex || ex.ok === false)) {
      /* Even when the stream fails, a series card still gets its part list -
         the viewer can pick another part instead of a dead end. */
      if (ex && isSeriesCard(it)) {
        var fl = epsToLadder(ex.episodes, ex.eps);
        if (fl.length > 1) setSeriesLadder(it, fl, false);
      }
      if (isSeriesCard(it)) refreshSeriesParts(it, ep);
      refail(); return;
    }
    if (ex && ex.ok !== false) {
      /* The extractor found the source page's sibling-episode ladder: the
         page-mode series engine turns on (selector + Prev/Next stay live
         across every episode switch). A stream that BELONGS to the ladder
         already on screen keeps it - the extractor's shorter answer must
         never shrink (or drop) the ladder the viewer is walking. Anything
         else replaces it; a non-episodic answer clears it. */
      var owned = ladderOwns(it);
      /* srv2 answers with BOTH ladder shapes for a multi-part page: `episodes`
         (the explicit [{ ep, title, url }] array the Web Series scrapers
         promise) and `eps` (the internal sibling ladder). Either drives the
         selector; the richer one wins. */
      var ladder = epsToLadder(ex.episodes, ex.eps);
      var s0 = state.series;
      if (ladder.length > 1 && owned && !(s0 && s0.provisional) && s0 && (s0.eps || []).length >= ladder.length) {
        /* Ours, and richer: keep it, follow the live page. */
        s0.idx = ladderIdx(s0.eps, it.page || it.url);
        paintSeriesControls();
      } else if (ladder.length > 1) {
        setSeriesLadder(it, ladder, false);
      } else if (isSeriesCard(it) && it.page && owned && s0 && s0.mode === 'page') {
        /* Series card, single-part answer: the live ladder stays (and keeps
           walking), the cursor just follows the part that is playing. */
        s0.idx = ladderIdx(s0.eps, it.page || it.url);
        paintSeriesControls();
      } else if (isSeriesCard(it) && it.page) {
        setSeriesLadder(it, ladder, true);
      } else if (state.series && !owned) {
        clearSeries();
      }
      /* A series card whose parts are not (yet) known: the real browser
         session reads the page itself in the background and upgrades the
         placeholder into the full part list. Playback never waits on it. */
      var sEnd = state.series;
      if (isSeriesCard(it) && it.page && sEnd && sEnd.mode === 'page' && (sEnd.eps || []).length < 2) refreshSeriesParts(it, ep);
      var nx = ex.next ? { url: ex.next, kind: it.kind || '', title: it.t } : null;
      if (ex.type === 'hls') { playStream(ex.native ? ex.file : (ex.play || ex.file), it.t, { onFail: refail, next: nx, subs: ex.subs || null }); return; }
      /* Direct files: Chromium fetches the upstream itself (main.js rewrites
         the Referer for media), with the local /raw twin as silent fallback.
         Node-side proxying of hotlink-protected CDNs gets 403s; the browser
         fingerprint does not. */
      if (ex.type === 'direct') {
        playStream(ex.file || ex.play, it.t, { fallback: (ex.play && ex.play !== ex.file) ? ex.play : '', onFail: refail, next: nx, subs: ex.subs || null });
        return;
      }
      /* These libraries have a raw-stream resolver; inside the 18+ vault an
         embed answer means the resolver failed and keeps its original retry
         ladder. Standard sections mount the resolver's clean player INSIDE
         the app window instead - playback never leaves it. */
      if (ex.type === 'embed' && ex.embed && CUSTOM_NATIVE.test(it.kind || '')) {
        if (!adult) { playEmbed(ex.embed, it.t, { watchdog: 30000, stallSwap: 30000, onStuck: refail }); return; }
        refail(); return;
      }
      if (ex.type === 'embed' && ex.embed) {
        /* A clean player iframe answered: standard sections mount it right
           here with the 30s rotation ceiling; the 18+ vault keeps its exact
           original budgets. */
        if (!adult) { playEmbed(ex.embed, it.t, { watchdog: 30000, stallSwap: 30000, onStuck: refail }); return; }
        playEmbed(ex.embed, it.t, { watchdog: 11000, stallSwap: 13000, onStuck: refail });
        return;
      }
      if (ex.tmdb) {
        /* A page that carries a real TMDB id (KatMovieHD movies/series...)
           skips the detail screen and goes straight into the provider race.
           A SERIES answer still never auto-plays: the episode menu opens and
           the viewer starts S1E1 (or any other episode) by hand. */
        var exRef = {
          tmdb: String(ex.tmdb), imdb: ex.imdb || '',
          type: (ex.mt === 'tv' || ex.type === 'tv') ? 'tv' : 'movie',
          season: Number(ex.season || 1) || 1, episode: Number(ex.episode || 1) || 1
        };
        var exC = { title: ex.title || it.t, poster: it.poster || '', ref: exRef };
        var picked = !!(it && it.__picked);
        var finish = function (c2) {
          return playTmdb(c2).catch(function () { unavailable(it); });
        };
        if (exRef.type === 'tv' && !picked) { pickTmdbSeries(exC); return; }
        finish(exC);
        return;
      }
    }
    var pg = String(it.page || it.url || '');
    /* Dynamic hosts never get a second chance through their own page: the
       shell needs their private player JS and renders black here. A failed
       extraction gets one fresh server attempt instead of a dead iframe. */
    if (DYNAMIC_HOST.test(pg)) {
      if (!re) { setTimeout(function () { if (ep === playEpoch) customPlay(it, true); }, 450); return; }
      unavailable(it); return;
    }
    if (ex && ex.isolated && CUSTOM_NATIVE.test(it.kind || '')) { refail(); return; }
    if (it.page && CUSTOM_NATIVE.test(it.kind || '')) { refail(); return; }
    /* Outside the 18+ vault a source page is NEVER mounted in a frame: the
       extraction already ran, so an embed-only answer means failure - retry
       once natively, then the native unavailable card. */
    if (!adult && ex && ex.isolated) { refail(); return; }
    if (!adult && it.page) { unavailable(it); return; }
    if (ex && ex.isolated) { playEmbed(ex.isolated, it.t); return; }
    if (it.page) {
      var B2 = await SC.alt();
      if (ep !== playEpoch) return;
      playEmbed(B2 + '/page?url=' + encodeURIComponent(it.page) + '&hide=1', it.t);
      return;
    }
    unavailable(it);
  }

  /* Live TV never dead-ends on one dead channel: a failure silently zaps to
     the next channel in the loaded list, exactly like a remote control. Only
     a full lap with nothing alive surfaces the unavailable card. */
  var liveTry = { i: 0, n: 0, name: 'Live' };
  function playLive(ch) {
    var list = liveChs || [];
    var idx = list.indexOf(ch);
    liveTry = { i: idx >= 0 ? idx : 0, n: 0, name: (ch && ch.name) || 'Live' };
    showPlayer(liveTry.name);
    clearSeries();
    zap();
    function zap() {
      var list2 = (liveChs && liveChs.length) ? liveChs : [ch];
      var c = list2[liveTry.i % list2.length] || ch;
      liveTry.n++;
      if (liveTry.n > Math.min(list2.length, 8) + 1) { showUnavailable(liveTry.name, { retry: function () { playLive(ch); } }); return; }
      var pt = $('#pTitle'); if (pt && c.name) pt.textContent = c.name;
      showLoading('Tuning ' + (c.name || 'channel') + '...');
      var ep = playEpoch;
      SC.base().then(function (B) {
        if (ep !== playEpoch) return;
        var u = B + '/hls?url=' + encodeURIComponent(c.url) +
                (c.ua ? '&ua=' + encodeURIComponent(c.ua) : '') +
                (c.ref ? '&ref=' + encodeURIComponent(c.ref) : '');
        playStream(u, c.name, { watchdog: 30000, onFail: function () { if (ep !== playEpoch) return; liveTry.i++; setTimeout(function () { if (ep === playEpoch) zap(); }, 250); } });
      });
    }
  }

  /* ---------------- unified click router ---------------- */
  function openItem(it) {
    if (!it) return;
    if (it.kind === 'tmdb' || it.kind === 'country') { detail(it); return; }
    if (it.kind === 'mb') { mbDetail(it); return; }
    if (it.kind === 'al') { openAl(it); return; }
    if (it.kind === 'arc') { showPlayer(it.t); clearSeries(); playArchive(it.arc, it.t); return; }
    if (it.kind === 'live') { playLive(it); return; }
    if (it.kind === 'yt') { ytPlay(it); return; }
    if (it.kind === 'r34') {
      if (it.file) { showPlayer(it.t); clearSeries(); var ep0 = playEpoch; SC.base().then(function (B) { if (ep0 !== playEpoch) return; playStream(B + '/raw?url=' + encodeURIComponent(it.file) + '&ref=' + encodeURIComponent(it.url || ''), it.t); }); return; }
      if (it.page) { try { window.bridge && window.bridge.openExternal(it.page); } catch (e) {} return; }
    }
    /* Universal episode select: a series card opens its episode menu and waits
       for an explicit episode click - never an automatic stream. */
    if (isSeriesCard(it) && (it.page || it.url)) { pickPageSeries(it); return; }
    /* Problem/part cards that arrived grouped: raise the episode ladder the
       instant the click lands, before the resolver has answered. */
    if ((it.kind === 'mv' || it.kind === 'htv') && !ladderOwns(it)) seedPageSeries(it);
    customPlay(it).catch(function () { showUnavailable(it.t, { retry: function () { customPlay(it); } }); });
  }

  /* ---------------- search ---------------- */
  function resultsHead(q, note) {
    var w = el('div', 'searchhead');
    w.appendChild(el('h3', null, 'Results for \u201C' + q + '\u201D'));
    if (note) w.appendChild(el('div', 'sub', note));
    return w;
  }

  function paintResultRows(c, defs) {
    /* A fresh results grid starts its own 18+ dedupe scope: posts remembered
       from the vault page never suppress a deliberate search. */
    r34Seen = new Set();
    var any = defs.some(function (d) { return (d[1] || []).length; });
    if (!any) { c.appendChild(el('div', 'empty', 'No matches found.')); return; }
    defs.forEach(function (d) {
      var items = prepareItems(d[1]);
      if (!items.length) return;
      var w = el('div', 'row');
      w.appendChild(el('h3', null, d[0]));
      var s = el('div', 'row-scroll');
      items.slice(0, 40).forEach(function (it) { s.appendChild(cardNode(it)); });
      w.appendChild(s);
      c.appendChild(w);
    });
  }

  /* Home = Super Search: TMDB + Anime + K-Drama + Web Series + YouTube fire
     in parallel into labeled rows. The 18+ vault is strictly excluded. */
  async function superSearch(q) {
    var c = content();
    c.innerHTML = '';
    c.appendChild(resultsHead(q, 'Movies & series, anime, K-drama, web series and YouTube sources'));
    var res = await Promise.all([
      mbSearch(q).catch(function () { return []; }),
      tmdbSearch(q).catch(function () { return []; }),
      anilistSearch(q).catch(function () { return []; }),
      SC.search(q, 'kdrama').catch(function () { return []; }),
      SC.search(q, 'webseries').catch(function () { return []; }),
      SC.ytSearch(q).catch(function () { return []; })
    ]);
    paintResultRows(c, [['Spotlight', res[0]], ['Movies & Series', res[1]], ['Anime', res[2]], ['K-Drama', res[3]], ['Web Series', res[4]], ['YouTube', res[5]]]);
  }

  /* Per-section search: queries ONLY the active tab's own sources. */
  async function sectionSearch(q, sec) {
    var c = content();
    c.innerHTML = '';
    if (sec === 'moviebox') {
      c.appendChild(resultsHead(q, 'Searching the SuperBox catalogue'));
      var rmb = await mbSearch(q).catch(function () { return []; });
      paintResultRows(c, [['Spotlight', rmb]]);
      return;
    }
    if (sec === 'anime') {
      c.appendChild(resultsHead(q, 'Anime sources only'));
      var r1 = await Promise.all([anilistSearch(q).catch(function () { return []; }), tmdbSearch(q).catch(function () { return []; })]);
      paintResultRows(c, [['Anime (AniList)', r1[0]], ['TMDB', r1[1]]]);
      return;
    }
    if (sec === 'kdrama') {
      c.appendChild(resultsHead(q, 'K-Drama sources only'));
      var r2 = await Promise.all([tmdbSearch(q).catch(function () { return []; }), SC.search(q, 'kdrama').catch(function () { return []; })]);
      paintResultRows(c, [['K-Drama (TMDB)', r2[0]], ['K-Drama sources', r2[1]]]);
      return;
    }
    if (sec === 'webseries') {
      c.appendChild(resultsHead(q, 'Web Series sources only'));
      var r3 = await Promise.all([tmdbSearch(q).catch(function () { return []; }), SC.search(q, 'webseries').catch(function () { return []; })]);
      paintResultRows(c, [['Web Series (TMDB)', r3[0]], ['Web Series sources', r3[1]]]);
      return;
    }
    if (sec === 'tube') {
      c.appendChild(resultsHead(q, 'YouTube only'));
      var ry = await SC.ytSearch(q).catch(function () { return []; });
      paintResultRows(c, [['Tube (YouTube)', ry]]);
      return;
    }
    if (sec === 'adult') {
      var sub = state.sub || 'jav';
      c.appendChild(resultsHead(q, vaultLabel(sub) + ' sources (18+)'));
      var r4 = await SC.search(q, 'adult', sub).catch(function () { return []; });
      paintResultRows(c, [[vaultLabel(sub), r4]]);
      return;
    }
    c.appendChild(resultsHead(q, ''));
    var r5 = await tmdbSearch(q).catch(function () { return []; });
    paintResultRows(c, [['TMDB', r5]]);
  }

  async function runSearch(q) {
    q = (q || '').trim();
    if (!q) return;
    var sec = state.section;
    if (sec === 'livetv') { state.liveFilter = q; paintLiveGrid(); return; }
    var c = content();
    c.innerHTML = '<div class="row"><div class="empty" style="padding:0 18px">Searching for &ldquo;' + esc(q) + '&rdquo;...</div></div>';
    if (sec === 'home') return superSearch(q);
    return sectionSearch(q, sec);
  }

  /* ---------------- settings ---------------- */
  function openSettings() {
    var m = $('#settingsModal');
    $('#setTmdb').value = store.key || '';
    var sel = $('#setLang');
    sel.innerHTML = '';
    (Z.LANGS || [['en-US', 'English']]).forEach(function (l) {
      var o = document.createElement('option'); o.value = l[0]; o.textContent = l[1]; sel.appendChild(o);
    });
    sel.value = store.lang || 'en-US';
    m.classList.remove('hidden');
  }
  function wireSettings() {
    $('#setClose').onclick = function () { $('#settingsModal').classList.add('hidden'); };
    $('#setSave').onclick = function () {
      store.key = $('#setTmdb').value.trim();
      store.lang = $('#setLang').value || 'en-US';
      save();
      $('#settingsModal').classList.add('hidden');
      toast('Settings saved.');
    };
  }

  /* ---------------- boot ---------------- */
  function boot() {
    document.querySelectorAll('#nav button').forEach(function (b) {
      b.onclick = function () { renderSection(b.getAttribute('data-sec')); };
    });
    $('#settingsBtn').onclick = openSettings;
    $('#searchForm').onsubmit = function (e) { e.preventDefault(); runSearch($('#searchInput').value); };
    $('#pClose').onclick = closePlayer;
    wireVideoControls();
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (!$('#settingsModal').classList.contains('hidden')) { $('#settingsModal').classList.add('hidden'); return; }
        if (window.READER && window.READER.back()) return;
        if (sourceFrame) { closeSourceFrame(); renderSection('sources'); return; }
        if (!player().classList.contains('hidden')) closePlayer();
      }
    });
    wireSettings();
    startVpnGate();
    window.sbBack = function () {
      if (window.READER && window.READER.back()) return true;
      if (sourceFrame) { closeSourceFrame(); renderSection('sources'); return true; }
      if (!$('#settingsModal').classList.contains('hidden')) { $('#settingsModal').classList.add('hidden'); return true; }
      if (!player().classList.contains('hidden')) { closePlayer(); return true; }
      if (state.section !== 'home') { renderSection('home'); return true; }
      return false;
    };
    renderSection('home');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
