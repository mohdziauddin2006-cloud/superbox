/* library.js - the unified SuperBox library data layer.
   ---------------------------------------------------------------------------
   Every catalogue lives here: TMDB/AniList rows, XMaal web series,
   KatMovieHD, KDramasMaza, archive.org cartoons, live TV, the ad-free Tube
   and the opt-in 18+ section. The app renders these rows inside the normal
   Home / Movies / Series / Anime library - there is no separate screen.
   Streams that resolve to a real MP4/HLS/DASH play in the SuperBox player;
   provider shells that cannot be extracted open in the in-app web player. */
(function () {
  'use strict';
  if (window.LIB) return;

  var App = window.SBApp;
  var S = (App && App.state) || {};
  var Z = window.ZAI || {};
  var SC = window.SC || {};
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var enc = function (v) { return encodeURIComponent(String(v == null ? '' : v)); };
  var esc = App.esc;

  var items = {};
  var seq = 0;
  var st = {
    sub: 'jav', token: 0, current: null, tmdb: null,
    season: 1, ep: 1, parts: [], partIdx: 0, loading: false
  };
  var liveChs = [];
  var liveGroup = 0;
  var detailEl, liveEl;

  var TITLES = {
    movie: { t: 'Movies', s: 'Blockbusters, Indian cinema and world films' },
    tv: { t: 'Series', s: 'Bingeable dramas, sitcoms and short series' },
    webseries: { t: 'Web Series', s: 'Desi and Indian web series, A-Z' },
    kdrama: { t: 'K-Drama', s: 'Korean drama, Hindi-dubbed and more' },
    anime: { t: 'Anime', s: 'Trending, top rated and anime movies' },
    kids: { t: 'Kids', s: 'Family films, animation and kids TV' },
    cartoons: { t: 'Cartoons', s: 'Classic animation from archive.org' },
    livetv: { t: 'Live TV', s: 'Free channels from around the world' },
    tube: { t: 'Tube', s: 'Ad-free YouTube: music, tech, comedy and more' },
    adult: { t: '18+', s: 'Adults only. Opt in from this screen.' }
  };

  /* Every row is tagged with the catalogue group it came from, so the
     unified Home/library views can show one continuous shelf. */
  function tagged(sec, rows, group) {
    return (rows || []).map(function (r) {
      var o = {};
      for (var k in r) o[k] = r[k];
      o.group = group;
      return o;
    });
  }

  function rowsForTab(tab) {
    var T = Z.TMDB_ROWS || {};
    if (tab === 'home') {
      return tagged('home', T.home || [], 'Spotlight')
        .concat(tagged('webseries', (T.webseries || []).slice(0, 1), 'Web Series'))
        .concat(tagged('kdrama', (T.kdrama || []).slice(0, 1), 'K-Drama'))
        .concat(tagged('cartoons', ((Z.ARCHIVE_ROWS || {}).cartoons || []).slice(0, 1), 'Cartoons'))
        .concat(tagged('tube', (Z.YT_ROWS || []).slice(0, 1), 'Tube'));
    }
    if (tab === 'movies') {
      return tagged('movie', T.movie || [], 'Movies')
        .concat(tagged('webseries', (T.webseries || []).slice(0, 2), 'Web Series'))
        .concat(tagged('cartoons', ((Z.ARCHIVE_ROWS || {}).cartoons || []).slice(0, 2), 'Cartoons'))
        .concat(tagged('tube', (Z.YT_ROWS || []).slice(0, 1), 'Tube'));
    }
    if (tab === 'series') {
      return tagged('tv', T.tv || [], 'Series')
        .concat(tagged('webseries', (T.webseries || []).slice(0, 2), 'Web Series'))
        .concat(tagged('kdrama', (T.kdrama || []).slice(0, 2), 'K-Drama'));
    }
    if (tab === 'anime') return tagged('anime', T.anime || [], 'Anime');
    return [];
  }

  // ---------------------------------------------------------------- helpers
  function getJson(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(function (t) {
      try { return JSON.parse(t); } catch (e) { throw new Error('bad json'); }
    });
  }
  function getText(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    });
  }
  function img(u) { return u ? App.imgUrl(u) : ''; }
  function clean(t) { return String(t || '').replace(/\s+/g, ' ').trim(); }
  function initials(t) {
    var c = String(t || '').replace(/[^A-Za-z0-9 ]/g, ' ').trim();
    if (!c) return 'SB';
    var w = c.split(/\s+/);
    return (w[0].charAt(0) + (w[1] ? w[1].charAt(0) : '')).toUpperCase();
  }
  function metaLine(it) {
    var m = [];
    if (it.year) m.push(it.year);
    if (it.dur) m.push(it.dur);
    else if (it.parts) m.push(it.parts + ' EP');
    if (it.rating) m.push('★ ' + it.rating);
    return m.join(' · ');
  }

  // ---------------------------------------------------------------- cards
  function card(it) {
    if (!it) return '';
    var id = 'wa' + (++seq);
    it.__wa = id;
    items[id] = it;
    var badge = it.badge || (it.kind === 'tmdb' ? 'TMDB' : '');
    var series = it.isSeries || it.parts > 0;
    return '<button class="card wa-card" data-lib="' + id + '" aria-label="' + esc(it.t) + '">' +
      '<div class="card-poster">' +
      '<span class="ph">' + esc(initials(it.t)) + '</span>' +
      (it.poster ? '<img src="' + esc(img(it.poster)) + '" alt="' + esc(it.t) + '" loading="lazy" decoding="async" onerror="SBIMG(this)">' : '') +
      (badge ? '<span class="card-tag wa-badge">' + esc(badge) + '</span>' : '') +
      (it.rating ? '<span class="card-rate">★ ' + esc(it.rating) + '</span>' : '') +
      (series ? '<span class="wa-series">SERIES</span>' : '') +
      '</div>' +
      '<div class="card-title">' + esc(it.t) + '</div>' +
      '<div class="card-meta">' + esc(metaLine(it)) + '</div>' +
      '</button>';
  }
  function cards(list) { return (list || []).map(card).join(''); }

  // ---------------------------------------------------------------- rows
  function rowsFor(sec, sub) {
    var T = Z.TMDB_ROWS || {};
    function tmdb(list) { return (list || []).map(function (r) { var o = {}; for (var k in r) o[k] = r[k]; o.kind = 'tmdb'; return o; }); }
    if (sec === 'home' || sec === 'movie' || sec === 'tv' || sec === 'kids') return tmdb(T[sec]);
    if (sec === 'anime') return tmdb(T.anime);
    if (sec === 'webseries') {
      var out = (Z.xmaalRows ? Z.xmaalRows((Z.XMAAL && Z.XMAAL.sfw) || [], 'XS') : []);
      out = out.concat(((Z.KAT && Z.KAT.ws) || []).map(function (r) { return { kind: 'kat', t: r.t, u: r.u, k: 'kat', badge: 'KAT' }; }));
      return out.concat(tmdb(T.webseries));
    }
    if (sec === 'kdrama') {
      var kd = ((Z.KAT && Z.KAT.kd) || []).map(function (r) {
        var k = r.k || 'kd';
        return { kind: k === 'hd' ? 'hd' : 'kat', t: r.t, u: r.u, k: k, badge: k === 'kd' ? 'KD' : (k === 'hd' ? 'HD' : 'KAT') };
      });
      return kd.concat(tmdb(T.kdrama));
    }
    if (sec === 'tube') return (Z.YT_ROWS || []).slice();
    if (sec === 'adult') return (((Z.VAULT || {})[sub || st.sub || 'jav']) || []).slice();
    if (sec === 'cartoons') return ((Z.ARCHIVE_ROWS || {}).cartoons || []).map(function (r) { var o = {}; for (var k in r) o[k] = r[k]; o.kind = 'arc'; return o; });
    return [];
  }

  async function tmdbRow(row) {
    if (row.al) return anilistRow(row);
    var path = row.p || '/trending/all/week';
    var q = row.q || {};
    var qs = [];
    Object.keys(q).forEach(function (k) { qs.push(enc(k) + '=' + enc(q[k])); });
    if (!q.page) qs.push('page=1');
    var j = await getJson('/tmdb/3' + path + '?' + qs.join('&'));
    var list = (j && j.results) || [];
    var fallback = /\/tv|\/discover\/tv/.test(path) ? 'tv' : 'movie';
    return list.map(function (m) {
      var mt = m.media_type || fallback;
      if (mt !== 'movie' && mt !== 'tv') mt = fallback;
      return {
        kind: 'tmdb', tmdb: m.id, mt: mt,
        t: clean(m.title || m.name || ''),
        poster: m.poster_path ? 'https://image.tmdb.org/t/p/w342' + m.poster_path : '',
        year: String(m.release_date || m.first_air_date || '').slice(0, 4),
        rating: m.vote_average ? Number(m.vote_average).toFixed(1) : '',
        badge: row.badge || 'TMDB'
      };
    }).filter(function (x) { return x.t && x.tmdb; });
  }

  async function anilistRow(row) {
    var sort = row.al || 'TRENDING_DESC';
    var fmt = row.fmt ? ',format:' + row.fmt : '';
    var q = '{Page(perPage:26){media(type:ANIME,sort:' + sort + fmt + ',isAdult:false){id title{romaji english} coverImage{large} startDate{year} averageScore}}}';
    var j = null;
    try {
      var r = await fetch('https://graphql.anilist.co', {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ query: q })
      });
      if (r.ok) j = await r.json();
    } catch (e) {}
    if (!j) {
      try { j = await getJson('/page?url=' + enc('https://graphql.anilist.co/?query=' + enc(q))); } catch (e) {}
    }
    var list = (j && j.data && j.data.Page && j.data.Page.media) || [];
    return list.map(function (m) {
      var title = m.title || {};
      return {
        kind: 'tmdb', tmdb: m.id, mt: 'tv', anilist: true,
        t: clean(title.english || title.romaji || ''),
        poster: (m.coverImage && m.coverImage.large) || '',
        year: (m.startDate && m.startDate.year) || '',
        rating: m.averageScore ? (m.averageScore / 10).toFixed(1) : '',
        badge: row.badge || 'ANIME'
      };
    }).filter(function (x) { return x.t; });
  }

  async function arcRow(row) {
    var u = 'https://archive.org/advancedsearch.php?q=' + enc('collection:' + row.arc + ' AND mediatype:movies') +
      '&fl[]=identifier&fl[]=title&fl[]=year&rows=24&page=1&output=json';
    var j = await getJson('/page?url=' + enc(u));
    var docs = (j && j.response && j.response.docs) || [];
    return docs.map(function (d) {
      return {
        kind: 'arc', arc: d.identifier, t: clean(d.title || d.identifier || ''),
        poster: 'https://archive.org/services/img/' + d.identifier,
        year: d.year || '', badge: row.badge || 'ARCHIVE'
      };
    }).filter(function (x) { return x.t && x.arc; });
  }

  async function javRow(row) {
    /* SC.javRow tries the local /jav feed first and falls back to parsing
       123av directly, so Android gets real JAV cards without a Java route. */
    try {
      var list = await SC.javRow(row);
      if (list && list.length) return list;
    } catch (e) {}
    var q = { new: 'japanese', hot: 'japanese', recent: 'japanese', today: 'japanese', week: 'japanese', top: 'japanese', uncensored: 'japanese uncensored', leaked: 'japanese uncensored', fc2: 'fc2' }[row.p] || 'japanese';
    try {
      return await SC.epRow({ q: q, order: row.p === 'new' ? 'latest' : 'top-weekly', badge: row.badge || 'JAV' });
    } catch (e) { return []; }
  }

  async function ytRow(row) {
    /* YouTube ships its bootstrap payload as a JS string literal with \xNN
       escapes ("var ytInitialData = '\x7b...'"). Trending no longer embeds
       items at all, so it uses YouTube's own Popular playlist; every other
       row is a normal search page. Metadata is all we need - playback opens
       the official embed in the in-app web player. */
    var urls = [];
    if (row.browse === 'trending') {
      urls.push('https://www.youtube.com/playlist?list=PLrEnWoR732-BHrPp_Pm8_VleD68f9s14-&hl=en&gl=US');
      urls.push('https://www.youtube.com/results?search_query=trending+videos+this+week&hl=en&gl=US');
    } else {
      urls.push('https://www.youtube.com/results?search_query=' + enc(row.q || '') + '&hl=en&gl=US');
    }
    var list = [];
    for (var i = 0; i < urls.length && !list.length; i++) {
      try {
        var html = await SC.fetchText(urls[i], 24000);
        list = parseYt(html);
      } catch (e) {}
    }
    return list.slice(0, 30).map(function (v) {
      return {
        kind: 'yt', vid: v.id, t: clean(v.title), badge: row.badge || 'YT',
        poster: 'https://i.ytimg.com/vi/' + v.id + '/hqdefault.jpg',
        dur: v.duration || '', rating: '', page: 'https://www.youtube.com/watch?v=' + v.id
      };
    });
  }

  /* Decode the JS string literal YouTube uses for its bootstrap payload. */
  function decodeJsString(s) {
    return String(s).replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|.)/g, function (m, g) {
      if (g.charAt(0) === 'x' || g.charAt(0) === 'u') {
        return String.fromCharCode(parseInt(g.slice(1), 16));
      }
      if (g === 'n') return '\n';
      if (g === 'r') return '\r';
      if (g === 't') return '\t';
      return g;
    });
  }

  function jsonAt(html, key) {
    var i = html.indexOf(key);
    if (i < 0) return null;
    var start = html.indexOf('{', i);
    if (start < 0) return null;
    var depth = 0, str = false, es = false;
    for (var p = start; p < html.length; p++) {
      var ch = html.charAt(p);
      if (str) {
        if (es) es = false;
        else if (ch === '\\') es = true;
        else if (ch === '"') str = false;
      } else {
        if (ch === '"') str = true;
        else if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (!depth) { try { return JSON.parse(html.slice(start, p + 1)); } catch (e) { return null; } } }
      }
    }
    return null;
  }

  function ytData(html) {
    /* Quoted payload first. */
    var i = html.indexOf('var ytInitialData = ');
    if (i >= 0) {
      var q1 = html.indexOf("'", i);
      var q2 = html.indexOf("';</script>", q1);
      if (q1 >= 0 && q2 > q1) {
        try { return JSON.parse(decodeJsString(html.slice(q1 + 1, q2))); } catch (e) {}
      }
    }
    /* Plain object payload (older pages). */
    return jsonAt(html, 'ytInitialData');
  }

  function ytText(o) {
    if (!o) return '';
    if (typeof o === 'string') return o;
    if (o.simpleText) return o.simpleText;
    if (o.content) return o.content;
    if (o.runs && o.runs[0]) return o.runs[0].text || '';
    return '';
  }

  function parseYt(html) {
    var data = ytData(html);
    var out = [], seen = {};
    if (!data) return out;
    function push(id, title, dur, views) {
      id = String(id || '');
      title = clean(title);
      if (!/^[\w-]{11}$/.test(id) || !title || seen[id] || out.length >= 40) return;
      seen[id] = 1;
      out.push({ id: id, title: title, duration: dur || '', views: views || '' });
    }
    function lockupDur(l) {
      try {
        var ov = l.contentImage.thumbnailViewModel.overlays || [];
        for (var a = 0; a < ov.length; a++) {
          var b = (ov[a].thumbnailBottomOverlayViewModel || {}).badges || [];
          for (var c = 0; c < b.length; c++) {
            var t = b[c].thumbnailBadgeViewModel && b[c].thumbnailBadgeViewModel.text;
            if (t && /^\d+:\d+/.test(t)) return t;
          }
        }
      } catch (e) {}
      return '';
    }
    function lockupViews(l) {
      try {
        var rows = l.metadata.lockupMetadataViewModel.metadata.contentMetadataViewModel.metadataRows || [];
        var part = rows[1] && rows[1].metadataParts && rows[1].metadataParts[0];
        return (part && part.text && part.text.content) || '';
      } catch (e) { return ''; }
    }
    (function walk(o) {
      if (!o || typeof o !== 'object' || out.length >= 40) return;
      if (Array.isArray(o)) { for (var i = 0; i < o.length; i++) walk(o[i]); return; }
      var v = o.videoRenderer || o.videoWithContextRenderer || o.gridVideoRenderer ||
              o.compactVideoRenderer || o.playlistVideoRenderer;
      if (v) push(v.videoId, ytText(v.title || v.headline), ytText(v.lengthText), ytText(v.shortViewCountText));
      if (o.lockupViewModel) {
        var l = o.lockupViewModel;
        var t = l.metadata && l.metadata.lockupMetadataViewModel && l.metadata.lockupMetadataViewModel.title;
        push(l.contentId, ytText(t), lockupDur(l), lockupViews(l));
      }
      for (var k in o) {
        if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
        var child = o[k];
        if (child && typeof child === 'object') walk(child);
      }
    })(data);
    return out;
  }

  async function loadRow(row) {
    if (!row) return [];
    if (row.kind === 'tmdb') return tmdbRow(row);
    if (row.kind === 'adv') {
      var q = row.q || {};
      return tmdbRow({ kind: 'tmdb', p: '/discover/movie', q: q, badge: row.badge });
    }
    if (row.kind === 'xs') return SC.xsRow(row.path, row);
    if (row.kind === 'kat') return SC.katRow({ t: row.t, u: row.u, k: row.k || 'kat' });
    if (row.kind === 'hd') return SC.hdRow(row);
    if (row.kind === 'arc') return arcRow(row);
    if (row.kind === 'ep') return SC.epRow(row);
    if (row.kind === 'r34v') return SC.r34vRow(row);
    if (row.kind === 'r34') return SC.r34Row(row);
    if (row.kind === 'jav') return javRow(row);
    if (row.kind === 'hc') return SC.hcRow(row);
    if (row.kind === 'htv') return SC.htvRow(row);
    if (row.kind === 'ai') return SC.aiRow(row);
    if (row.kind === 'ytr') return ytRow(row);
    if (row.kind === 'country') return SC.countryRow(row);
    return [];
  }

  // ---------------------------------------------------------------- rows
  function rowShell(row, n) {
    var label = row.t || 'Featured';
    var group = row.group ? '<span class="lib-group">' + esc(row.group) + '</span>' : '';
    return '<section class="section wa-row" data-row="' + n + '">' +
      '<div class="section-head"><h2>' + group + esc(label) + '</h2><span class="wa-count">…</span></div>' +
      '<div class="row-track wa-track">' + skeletonCards(5) + '</div></section>';
  }

  function skeletonCards(n) {
    var s = '';
    for (var i = 0; i < n; i++) s += '<div class="sk-card wa-sk"><div class="sk sk-poster"></div><div class="sk sk-line"></div><div class="sk sk-line short"></div></div>';
    return s;
  }

  // ------------------------------------------------------------ row cache
  /* Heavy local state cache: every answered row is persisted so the next
     launch paints instantly (stale-while-revalidate). Cached rows render
     synchronously, then refresh in the background - a slow upstream can no
     longer leave a visible "Loading..." row, and a dead upstream keeps the
     last good cards instead of blanking the shelf. */
  var ROW_CACHE_KEY = 'sb.rows.v2';
  var rowMem = {};
  var rowCacheLoaded = false;
  var rowSaveTimer = 0;
  function loadRowCache() {
    if (rowCacheLoaded) return;
    rowCacheLoaded = true;
    try {
      var box = JSON.parse(localStorage.getItem(ROW_CACHE_KEY) || 'null');
      if (box && box.rows && typeof box.rows === 'object') rowMem = box.rows;
    } catch (e) { rowMem = {}; }
  }
  function saveRowCache() {
    if (rowSaveTimer) clearTimeout(rowSaveTimer);
    rowSaveTimer = setTimeout(function () {
      rowSaveTimer = 0;
      try {
        var keys = Object.keys(rowMem);
        if (keys.length > 64) {
          keys.sort(function (a, b) { return (rowMem[a].at || 0) - (rowMem[b].at || 0); });
          keys.slice(0, keys.length - 64).forEach(function (k) { delete rowMem[k]; });
        }
        localStorage.setItem(ROW_CACHE_KEY, JSON.stringify({ v: 2, rows: rowMem }));
      } catch (e) {
        /* Quota exceeded: keep the in-memory cache and clear the disk copy
           rather than breaking row rendering. */
        try { localStorage.removeItem(ROW_CACHE_KEY); } catch (e2) {}
      }
    }, 240);
  }
  function rowKey(row) {
    return [row.kind || '', row.p || '', row.q || '', row.u || row.path || '',
      row.k || '', row.t || '', st.sub || ''].join('|').slice(0, 300);
  }
  function cacheTake(row) {
    loadRowCache();
    var e = rowMem[rowKey(row)];
    if (!e || !Array.isArray(e.items) || !e.items.length) return null;
    if (Date.now() - (e.at || 0) > 6 * 3600 * 1000) return null;
    return e.items;
  }
  function cachePut(row, list) {
    if (!list || !list.length) return;
    var items = list.slice(0, 32);
    if (JSON.stringify(items).length > 60000) return;
    rowMem[rowKey(row)] = { at: Date.now(), items: items };
    saveRowCache();
  }

  function paintRows(host, rows, token) {
    loadRowCache();
    var queue = [];
    rows.forEach(function (row, i) {
      var wrap = document.createElement('div');
      wrap.innerHTML = rowShell(row, i);
      var el = wrap.firstChild;
      host.appendChild(el);
      var cached = cacheTake(row);
      if (cached) {
        var track0 = $('.wa-track', el);
        if (track0) track0.innerHTML = cards(cached.slice(0, 24));
        var count0 = $('.wa-count', el);
        if (count0) count0.textContent = cached.length + ' titles';
        el.setAttribute('data-cached', '1');
      }
      queue.push({ row: row, el: el });
    });
    var idx = 0, active = 0, pending = [];
    var lazyIO = null;
    function pump() {
      if (token !== st.token) return;
      while (active < 4 && pending.length) {
        var q = pending.shift();
        active++;
        loadOne(q, token).then(function () { active--; pump(); }, function () { active--; pump(); });
      }
    }
    /* Viewport-driven hydration, exactly like the desktop vault: the first
       rows hydrate immediately, the rest start ~700px before they appear.
       The vault has 60+ Eporner rows; firing every upstream request at launch
       rate-limited the API and made the first tap wait ~20s. */
    function need(q) {
      if (q.queued || q.done) return;
      q.queued = true;
      pending.push(q);
      pump();
    }
    queue.slice(0, 4).forEach(need);
    if (typeof IntersectionObserver !== 'undefined') {
      try {
        lazyIO = new IntersectionObserver(function (ents) {
          ents.forEach(function (en) {
            if (!en.isIntersecting) return;
            try { lazyIO.unobserve(en.target); } catch (e) {}
            var q = queue.filter(function (x) { return x.el === en.target; })[0];
            if (q) need(q);
          });
        }, { rootMargin: '700px 0px' });
        queue.slice(4).forEach(function (q) { lazyIO.observe(q.el); });
      } catch (e) {
        queue.slice(4).forEach(need);
      }
    } else {
      queue.slice(4).forEach(need);
    }
  }

  /* Called by app.js after the Spotlight rows are on screen. One token per
     view keeps late responses from painting into a tab the user left. */
  function appendRows(host, tab) {
    if (!host) return;
    var rows = rowsForTab(tab);
    if (!rows.length) return;
    st.token++;
    paintRows(host, rows, st.token);
  }

  async function loadOne(q, token) {
    var track = $('.wa-track', q.el);
    var count = $('.wa-count', q.el);
    var cached = cacheTake(q.row);
    var list = [];
    var timer = 0;
    try {
      /* Hard ceiling per row: no upstream combination may keep a shelf on
         "Loading..." beyond 22s. The cache is painted first, so the wait is
         invisible whenever this row answered before. */
      list = await Promise.race([
        loadRow(q.row),
        new Promise(function (res) {
          timer = setTimeout(function () { res(null); }, 22000);
        })
      ]);
      clearTimeout(timer);
      list = dedupe(list || []);
    } catch (e) {
      clearTimeout(timer);
      list = [];
    }
    if (token !== st.token || !q.el.isConnected) return;
    if (!list.length) {
      if (cached && cached.length) {
        if (!track) return;
        track.innerHTML = cards(cached.slice(0, 24));
        if (count) count.textContent = cached.length + ' cached';
        q.el.setAttribute('data-cached', '1');
        return;
      }
      q.el.classList.add('wa-empty-row');
      if (count) count.textContent = 'unavailable';
      if (track) track.innerHTML = '<div class="wa-note">This source did not answer. Try another row or refresh.</div>';
      return;
    }
    q.el.classList.remove('wa-empty-row');
    q.el.removeAttribute('data-cached');
    if (count) count.textContent = list.length + ' titles';
    if (track) track.innerHTML = cards(list.slice(0, 24));
    cachePut(q.row, list);
  }

  function dedupe(list) {
    var seen = {};
    return (list || []).filter(function (it) {
      if (!it || !it.t) return false;
      var k = it.page || it.file || it.vid || it.arc || (it.tmdb ? it.tmdb + ':' + it.mt : '') ||
        ((it.kind || '') + ':' + it.t);
      if (seen[k]) return false;
      seen[k] = 1;
      return true;
    });
  }

  // ------------------------------------------------------------ live TV view
  function openLive() {
    st.token++;
    closeDetail(true);
    var view = document.getElementById('view');
    if (!view) return;
    view.innerHTML = '<div class="page-head">' +
      '<button class="lib-back" data-lib-home aria-label="Back to Home">‹ Back</button>' +
      '<div class="page-kicker">SuperBox library</div>' +
      '<h1 class="page-title">Live TV</h1>' +
      '<div class="page-sub">Free channels from around the world</div></div>' +
      '<div id="libLiveBody"></div>';
    renderLive(document.getElementById('libLiveBody'), st.token);
    window.scrollTo(0, 0);
  }

  // ------------------------------------------------------------ 18+ view
  function openAdult() {
    var html = '<div class="sheet-title">18+ library</div>' +
      '<div class="sheet-sub">This section contains adult material. It is hidden from the main rows until you opt in.</div>' +
      '<div class="wa-src-note" style="padding:4px 16px 16px">Only continue if you are legally an adult where you live.</div>' +
      '<div style="display:flex;gap:10px;padding:0 16px 20px">' +
      '<button class="btn-primary" data-adult-yes style="flex:1">I am 18 or older</button>' +
      '<button class="btn-ghost" data-adult-no style="flex:1">Cancel</button></div>';
    App.openSheet(html, function (root) {
      var yes = root.querySelector('[data-adult-yes]');
      var no = root.querySelector('[data-adult-no]');
      if (yes) yes.onclick = function () { App.closeSheet(); renderAdult(); };
      if (no) no.onclick = function () { App.closeSheet(); };
    });
  }

  function renderAdult() {
    st.token++;
    closeDetail(true);
    var view = document.getElementById('view');
    if (!view) return;
    view.innerHTML = '<div class="page-head">' +
      '<button class="lib-back" data-lib-home aria-label="Back to Home">‹ Back</button>' +
      '<div class="page-kicker">SuperBox library</div>' +
      '<h1 class="page-title">18+</h1>' +
      '<div class="page-sub">Adults only</div>' +
      '<div class="chips" id="libAdultChips">' + vaultChips() + '</div></div>' +
      '<div id="libAdultRows"></div>';
    var token = st.token;
    var top = document.getElementById('libAdultRows');
    paintRows(top, rowsFor('adult', st.sub), token);
    $$('#libAdultChips .chip').forEach(function (b) {
      b.onclick = function () {
        st.sub = b.getAttribute('data-vsub');
        top.innerHTML = '';
        $$('#libAdultChips .chip').forEach(function (x) { x.classList.toggle('on', x === b); });
        st.token++;
        paintRows(top, rowsFor('adult', st.sub), st.token);
      };
    });
    window.scrollTo(0, 0);
  }

  function vaultChips() {
    return (Z.VAULT_GROUPS || []).map(function (g) {
      return '<button class="chip' + (g.id === st.sub ? ' on' : '') + '" data-vsub="' + esc(g.id) + '">' + esc(g.t) + '</button>';
    }).join('');
  }

  // ---------------------------------------------------------------- search
  async function searchAll(q) {
    var jobs = [
      tmdbSearch(q),
      SC.search(q, 'webseries').catch(function () { return []; }),
      SC.search(q, 'kdrama').catch(function () { return []; })
    ];
    var out = [];
    for (var i = 0; i < jobs.length; i++) {
      try {
        var part = await jobs[i];
        if (part && part.length) out = out.concat(part);
      } catch (e) {}
    }
    return dedupe(out).slice(0, 60);
  }

  async function tmdbSearch(q) {
    try {
      var j = await getJson('/tmdb/3/search/multi?query=' + enc(q) + '&include_adult=false&page=1');
      return ((j && j.results) || []).filter(function (m) {
        return m.media_type === 'movie' || m.media_type === 'tv';
      }).map(function (m) {
        return {
          kind: 'tmdb', tmdb: m.id, mt: m.media_type,
          t: clean(m.title || m.name || ''),
          poster: m.poster_path ? 'https://image.tmdb.org/t/p/w342' + m.poster_path : '',
          year: String(m.release_date || m.first_air_date || '').slice(0, 4),
          rating: m.vote_average ? Number(m.vote_average).toFixed(1) : '', badge: 'TMDB'
        };
      });
    } catch (e) { return []; }
  }

  // ---------------------------------------------------------------- live TV
  function renderLive(body, token) {
    body.innerHTML = '<div class="wa-livebar">' +
      '<select id="waLiveGroup" class="wa-select">' + (Z.LIVE.groups || []).map(function (g, i) {
        return '<option value="' + i + '">' + esc(g.t) + '</option>';
      }).join('') + '</select>' +
      '<input id="waLiveFilter" class="wa-livefilter" type="search" placeholder="Filter channels...">' +
      '</div><div id="waLiveGrid" class="wa-livegrid"><div class="empty">Loading channels…</div></div>';
    var sel = document.getElementById('waLiveGroup');
    var filter = document.getElementById('waLiveFilter');
    function paint() {
      var grid = document.getElementById('waLiveGrid');
      if (!grid) return;
      var f = String(filter && filter.value || '').toLowerCase();
      var list = liveChs.filter(function (c) { return !f || String(c.name || '').toLowerCase().indexOf(f) >= 0; });
      if (!list.length) {
        grid.innerHTML = '<div class="empty">No channels responded.</div>';
        return;
      }
      grid.innerHTML = list.slice(0, 200).map(function (c, i) {
        return '<button class="wa-ch" data-live="' + i + '">' +
          '<span class="wa-ch-logo">' + (c.logo ? '<img src="' + esc(img(c.logo)) + '" loading="lazy" onerror="SBIMG(this)">' : '') + '</span>' +
          '<span class="wa-ch-name">' + esc(c.name || 'Channel') + '</span>' +
          '<span class="wa-ch-group">' + esc(c.group || 'Live') + '</span></button>';
      }).join('');
      $$('.wa-ch', grid).forEach(function (b) {
        b.onclick = function () {
          var idx = Number(b.getAttribute('data-live'));
          var c = list[idx];
          if (c) playLive(c);
        };
      });
    }
    filter.oninput = paint;
    function load(i) {
      liveGroup = i;
      var grid = document.getElementById('waLiveGrid');
      if (grid) grid.innerHTML = '<div class="empty">Loading channels…</div>';
      SC.liveList(Z.LIVE.groups[i]).then(function (chs) {
        if (token !== st.token) return;
        liveChs = chs || [];
        paint();
      }).catch(function () {
        if (grid) grid.innerHTML = '<div class="empty">This channel group is unavailable.</div>';
      });
    }
    sel.onchange = function () { load(Number(sel.value)); };
    load(liveGroup || 0);
  }

  function playLive(ch) {
    if (!ch || !ch.url) return;
    App.playDirect(ch.url, ch.name || 'Live TV', { hls: true, ref: ch.ref || '' });
  }

  // ---------------------------------------------------------------- sources
  function openLibrarySources() {
    var rows = [
      ['✦', 'Metadata & discovery', 'TMDB · AniList'],
      ['▤', 'Web series & cinema', 'XMaal · KatMovieHD · KDramasMaza · HindiDrama'],
      ['◐', 'Classic animation', 'Internet Archive (archive.org)'],
      ['▶', 'Tube', 'YouTube'],
      ['◉', 'Live TV', 'iptv-org · Free-TV'],
      ['!', '18+ library', 'Eporner · 123av · Rule34 · Hentaicity · Hentai.tv'],
      ['∞', 'Streams', 'Public embed providers, resolved at play time']
    ];
    var html = '<div class="sheet-title">Library sources</div>' +
      '<div class="sheet-sub">Every catalogue that powers this library.</div>' +
      '<div class="wa-src-list">' + rows.map(function (r) {
        return '<div class="wa-src-item"><span class="wa-src-ic">' + r[0] + '</span>' +
          '<div><b>' + esc(r[1]) + '</b><span>' + esc(r[2]) + '</span></div></div>';
      }).join('') + '</div>' +
      '<div class="wa-src-note">SuperBox does not host media. Titles, artwork and streams stay with their sources and play inside the app.</div>';
    App.openSheet(html);
  }

  // ---------------------------------------------------------------- boot
  function boot() {
    buildDetail();
    document.addEventListener('click', function (e) {
      if (e.target.closest('[data-lib-sources]')) {
        e.preventDefault();
        openLibrarySources();
        return;
      }
      var lv = e.target.closest('[data-lib-live]');
      if (lv) { e.preventDefault(); openLive(); return; }
      var ad = e.target.closest('[data-lib-adult]');
      if (ad) { e.preventDefault(); openAdult(); return; }
      var c = e.target.closest('[data-lib]');
      if (c) {
        var it = items[c.getAttribute('data-lib')];
        if (it) { e.preventDefault(); openItem(it); }
      }
    });
  }

  // ---------------------------------------------------------------- detail
  function buildDetail() {
    if (detailEl) return;
    detailEl = document.createElement('div');
    detailEl.id = 'waDetail';
    detailEl.className = 'wa-detail hidden';
    detailEl.setAttribute('aria-hidden', 'true');
    detailEl.innerHTML = '<div class="wad-scroll" id="wadScroll"></div>';
    document.body.appendChild(detailEl);
    detailEl.addEventListener('click', onDetailClick);
  }

  function openItem(it) {
    if (!it) return;
    App.closeSheet();
    st.current = it;
    st.tmdb = null;
    st.parts = [];
    st.partIdx = 0;
    st.season = 1;
    st.ep = 1;
    detailEl.classList.remove('hidden');
    detailEl.setAttribute('aria-hidden', 'false');
    document.body.classList.add('wa-modal');
    detailEl.innerHTML = '<div class="wad-scroll" id="wadScroll">' + loadingDetail(it) + '</div>';
    if (it.kind === 'tmdb' || it.kind === 'country') {
      loadTmdbDetail(it);
    } else {
      renderCustomDetail(it, null);
      if (it.isSeries || it.parts > 0 || /^(xs|kat|kd|hd|ai|htv)$/.test(it.kind || '')) loadParts(it);
    }
  }

  function closeDetail(silent) {
    if (!detailEl || detailEl.classList.contains('hidden')) return;
    detailEl.classList.add('hidden');
    detailEl.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('wa-modal');
    if (!silent) st.current = null;
  }

  function loadingDetail(it) {
    return '<div class="wad-hero" style="background-image:' + (it.poster ? 'url(\'' + esc(img(it.poster)) + '\')' : 'none') + '">' +
      '<div class="wad-shade"></div><div class="wad-heroin">' +
      '<div class="wad-poster sk"></div><div class="wad-info"><h1>' + esc(it.t || 'Loading…') + '</h1>' +
      '<div class="wad-meta">Loading details…</div></div></div></div>' +
      '<div class="wad-body"><div class="wa-note">Fetching metadata and sources…</div></div>';
  }

  function hostOf(u) {
    try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
  }

  async function loadTmdbDetail(it) {
    var mt = it.mt === 'tv' ? 'tv' : 'movie';
    try {
      var j = await getJson('/tmdb/3/' + mt + '/' + enc(it.tmdb) + '?append_to_response=external_ids');
      if (st.current !== it) return;
      st.tmdb = j;
      renderTmdbDetail(it, j);
    } catch (e) {
      if (st.current !== it) return;
      renderCustomDetail(it, null);
    }
  }

  function renderTmdbDetail(it, d) {
    var mt = it.mt === 'tv' ? 'tv' : 'movie';
    var title = clean(d.title || d.name || it.t);
    var year = String(d.release_date || d.first_air_date || it.year || '').slice(0, 4);
    var rating = d.vote_average ? Number(d.vote_average).toFixed(1) : '';
    var genres = (d.genres || []).map(function (g) { return g.name; }).slice(0, 3).join(' · ');
    var backdrop = d.backdrop_path ? 'https://image.tmdb.org/t/p/w780' + d.backdrop_path : (it.poster || '');
    var poster = d.poster_path ? 'https://image.tmdb.org/t/p/w342' + d.poster_path : (it.poster || '');
    var meta = [year, rating ? '★ ' + rating : '', genres].filter(Boolean).join('   ·   ');
    var body = '<div class="wad-body">' +
      '<div class="wad-actions">' +
      '<button class="btn-primary" data-wad-play>' + iconPlay() + ' ' + (mt === 'tv' ? 'Play S1E1' : 'Play now') + '</button>' +
      '<button class="btn-ghost" data-wad-src>Sources</button>' +
      (it.anilist ? '<span class="wa-pill">AniList</span>' : '<span class="wa-pill">TMDB</span>') +
      '</div>' +
      (d.overview ? '<p class="wad-desc">' + esc(d.overview) + '</p>' : '') +
      (mt === 'tv' ? '<div class="wad-seasons" id="wadSeasons">' + seasonChips(d.seasons || [], st.season) + '</div><div class="wad-eplist" id="wadEps"><div class="wa-note">Loading episodes…</div></div>' : '') +
      '</div>';
    detailEl.innerHTML = '<div class="wad-scroll" id="wadScroll">' + heroHtml(title, poster, backdrop, meta, it.badge || (mt === 'tv' ? 'SERIES' : 'MOVIE')) + body + '</div>';
    if (mt === 'tv') loadSeason(it, st.season);
  }

  function seasonChips(seasons, active) {
    return (seasons || []).filter(function (s) { return s.season_number > 0; }).map(function (s) {
      return '<button class="chip' + (s.season_number === active ? ' on' : '') + '" data-wad-season="' + s.season_number + '">Season ' + s.season_number + '</button>';
    }).join('');
  }

  async function loadSeason(it, se) {
    st.season = se;
    var host = document.getElementById('wadEps');
    if (host) host.innerHTML = '<div class="wa-note">Loading episodes…</div>';
    try {
      var j = await getJson('/tmdb/3/tv/' + enc(it.tmdb) + '/season/' + se);
      if (st.current !== it) return;
      var eps = (j && j.episodes) || [];
      var chips = document.getElementById('wadSeasons');
      if (chips && st.tmdb) chips.innerHTML = seasonChips(st.tmdb.seasons || [], se);
      if (!host) return;
      if (!eps.length) { host.innerHTML = '<div class="wa-note">No episode list for this season.</div>'; return; }
      host.innerHTML = eps.map(function (e) {
        return '<button class="wad-ep' + (e.episode_number === st.ep ? ' on' : '') + '" data-wad-ep="' + e.episode_number + '">' +
          '<span class="wad-ep-n">' + e.episode_number + '</span>' +
          '<span class="wad-ep-tx"><b>' + esc(e.name || ('Episode ' + e.episode_number)) + '</b>' +
          '<em>' + esc([e.air_date, e.runtime ? e.runtime + 'm' : ''].filter(Boolean).join(' · ')) + '</em></span>' +
          '<span class="wad-ep-play">▶</span></button>';
      }).join('');
      var playBtn = $('[data-wad-play]', detailEl);
      if (playBtn) playBtn.innerHTML = iconPlay() + ' Play S' + se + 'E' + st.ep;
    } catch (e) {
      if (host) host.innerHTML = '<div class="wa-note">Could not load this season.</div>';
    }
  }

  function heroHtml(title, poster, backdrop, meta, badge) {
    return '<div class="wad-hero" style="background-image:' + (backdrop ? 'url(\'' + esc(img(backdrop)) + '\')' : 'none') + '">' +
      '<div class="wad-shade"></div>' +
      '<button class="wad-back" data-wad-back aria-label="Back">' + iconBack() + '</button>' +
      '<button class="wad-x" data-wad-back aria-label="Close">✕</button>' +
      '<div class="wad-heroin">' +
      '<div class="wad-poster">' + (poster ? '<img src="' + esc(img(poster)) + '" alt="" onerror="SBIMG(this)">' : '') + '</div>' +
      '<div class="wad-info">' +
      (badge ? '<span class="wad-kicker">' + esc(badge) + '</span>' : '') +
      '<h1>' + esc(title) + '</h1>' +
      (meta ? '<div class="wad-meta">' + esc(meta) + '</div>' : '') +
      '</div></div></div>';
  }

  function iconPlay() { return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l10-6.5-10-6.5Z"></path></svg>'; }
  function iconBack() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"></path></svg>'; }

  function providerUrl(p, it, se, ep) {
    var tpl = it.mt === 'tv' ? p.t : p.m;
    if (!tpl) return '';
    return tpl.replace('{id}', enc(it.tmdb)).replace('{s}', se).replace('{e}', ep);
  }

  function providersFor(it) {
    return (Z.PROVIDERS || []).filter(function (p) {
      return (p.ids || []).indexOf('tmdb') >= 0 && (it.mt !== 'tv' || p.t);
    });
  }

  function playTmdb(it) {
    var list = providersFor(it);
    if (!list.length) { App.toast('No provider is configured for this title'); return; }
    App.openLadder(ladderFor(it, 0), tmdbTitle(it));
  }

  /* The overlay rotates to the next provider when one answers with a dead
     shell, so the whole ladder is handed over, starting at the chosen entry. */
  function ladderFor(it, start) {
    var list = providersFor(it);
    var out = [], seen = {};
    for (var k = 0; k < list.length; k++) {
      var p = list[(start + k) % list.length];
      var u = providerUrl(p, it, st.season, st.ep);
      if (u && !seen[u]) { seen[u] = 1; out.push(u); }
    }
    return out;
  }

  function tmdbTitle(it) {
    return it.t + (it.mt === 'tv' ? ' · S' + st.season + 'E' + st.ep : '');
  }

  function openSources(it) {
    var list = providersFor(it);
    if (!list.length) { App.toast('No sources available'); return; }
    var html = '<div class="sheet-title">Sources</div><div class="sheet-sub">Provider shells open in the in-app web player. Extracted streams play natively.</div><div class="opt-list">' +
      list.map(function (p, i) {
        var url = providerUrl(p, it, st.season, st.ep);
        return '<button class="opt" data-prov="' + i + '"><span class="opt-ic">▶</span><span class="opt-txt"><b>' + esc(p.n) + '</b><span>' + esc(hostOf(url) || 'provider') + '</span></span></button>';
      }).join('') + '</div>';
    App.openSheet(html, function (host) {
      $$('[data-prov]', host).forEach(function (b) {
        b.onclick = function () {
          var idx = Number(b.getAttribute('data-prov')) || 0;
          App.closeSheet();
          App.openLadder(ladderFor(it, idx), tmdbTitle(it));
        };
      });
    });
  }

  // ---------------------------------------------------------- custom detail
  function renderCustomDetail(it, parts) {
    var title = clean(it.t || 'Untitled');
    var badge = it.badge || '';
    var timeBadge = /^\d{1,2}:\d{2}(?::\d{2})?$/.test(badge);
    var meta = [it.year, it.dur || (timeBadge ? badge : ''), it.parts ? it.parts + ' parts' : '', timeBadge ? '' : badge].filter(Boolean).join('   ·   ');
    var desc = it.desc || '';
    var series = it.isSeries || it.parts > 0 || /^(xs|kat|kd|hd|jav|ai|htv)$/.test(it.kind || '');
    var body = '<div class="wad-body">' +
      '<div class="wad-actions">' +
      '<button class="btn-primary" data-wad-play>' + iconPlay() + ' ' + (parts && parts.length ? 'Play E1' : 'Play now') + '</button>' +
      '<button class="btn-ghost" data-wad-src>' + (it.kind === 'yt' ? 'YouTube' : 'Source page') + '</button>' +
      (!timeBadge && badge ? '<span class="wa-pill">' + esc(badge) + '</span>' : '') +
      '</div>' +
      (desc ? '<p class="wad-desc">' + esc(desc) + '</p>' : '') +
      '<div class="wa-source">' + esc(hostOf(it.page || it.url) || '') + '</div>' +
      (series ? '<div class="wad-eplist" id="wadParts">' + (parts && parts.length ? partsHtml(parts) : '<div class="wa-note">Looking for episodes…</div>') + '</div>' : '') +
      '</div>';
    detailEl.innerHTML = '<div class="wad-scroll" id="wadScroll">' + heroHtml(title, it.poster || '', it.poster || '', meta, timeBadge ? 'EPISODE' : (badge || 'SOURCE')) + body + '</div>';
  }

  function partsHtml(parts) {
    if (!parts || !parts.length) return '<div class="wa-note">No episode list found. Play opens the source page.</div>';
    return '<div class="wad-partshead">' + parts.length + ' episodes</div>' + parts.map(function (p, i) {
      return '<button class="wad-ep" data-wad-part="' + i + '">' +
        '<span class="wad-ep-n">' + (p.n || (i + 1)) + '</span>' +
        '<span class="wad-ep-tx"><b>' + esc(p.t || ('Episode ' + (p.n || (i + 1)))) + '</b>' +
        '<em>' + esc(hostOf(p.url) || '') + '</em></span>' +
        '<span class="wad-ep-play">▶</span></button>';
    }).join('');
  }

  /* XMaal landing pages link to the show's own /series/<slug>/ page, which is
     where the numbered episode ladder lives. Follow that one hop when the
     landing page has no ladder of its own. */
  function seriesLink(html, pageUrl) {
    var re = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]{0,160}?)<\/a>/gi, m, host = '';
    try { host = new URL(pageUrl).hostname.replace(/^www\./i, ''); } catch (e) { return ''; }
    while ((m = re.exec(html))) {
      var href = m[1];
      if (!/\/series\//i.test(href)) continue;
      var abs = '';
      try { abs = new URL(href, pageUrl).href; } catch (e) { continue; }
      if (abs.indexOf(host) < 0) continue;
      if (abs.replace(/[?#].*$/, '') === pageUrl.replace(/[?#].*$/, '')) continue;
      return abs;
    }
    return '';
  }

  /* Some show pages number episodes only by query token ('?ep=3') while the
     landing slug differs from the show slug. Collect those links directly -
     text must read like an episode so navigation links never qualify. */
  function looseParts(html, pageUrl) {
    var host = '';
    try { host = new URL(pageUrl).hostname.replace(/^www\./i, ''); } catch (e) { return []; }
    var re = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi, m;
    var out = [], seen = {};
    while ((m = re.exec(html))) {
      var abs = '';
      try { abs = new URL(m[1], pageUrl).href; } catch (e) { continue; }
      if (abs.indexOf(host) < 0) continue;
      var q = abs.match(/[?&](?:ep|episode|e)=(\d+)/i);
      if (!q) continue;
      var n = Number(q[1]);
      if (!n || seen[n]) continue;
      var txt = m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      if (txt && !/episode|ep\b|part/i.test(txt)) continue;
      seen[n] = 1;
      out.push({ n: n, s: 0, url: abs, t: txt.slice(0, 120) || ('Episode ' + n) });
    }
    out.sort(function (a, b) { return a.n - b.n; });
    return out;
  }

  function ogImage(html, pageUrl) {
    var pre = html.match(/<link[^>]+rel=["']preload["'][^>]*>/gi) || [];
    for (var i = 0; i < pre.length; i++) {
      if (!/as=["']image["']/i.test(pre[i])) continue;
      var h = pre[i].match(/href=["']([^"']+)["']/i);
      if (h && h[1]) {
        try { return new URL(h[1].replace(/&amp;/g, '&'), pageUrl).href; } catch (e) {}
      }
    }
    var m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
            html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (!m || !m[1]) return '';
    try { return new URL(m[1].replace(/&amp;/g, '&'), pageUrl).href; } catch (e) { return ''; }
  }

  /* Listing thumbnails can 404 while the detail page's og:image is valid;
     refresh the hero/poster once the real page has been read. */
  function applyCustomPoster(it) {
    if (!it.poster || st.current !== it) return;
    var hero = detailEl.querySelector('.wad-hero');
    if (hero) hero.style.backgroundImage = "url('" + img(it.poster) + "')";
    var box = detailEl.querySelector('.wad-heroin .wad-poster');
    if (box) box.innerHTML = '<img src="' + esc(img(it.poster)) + '" alt="" onerror="SBIMG(this)">';
  }

  /* JAV / AI rows carry their own episode ladder that the generic page
     scraper cannot see (player payload / Next.js flight data). These two
     helpers normalize that map into the same {n,t,url} shape the picker
     already renders, so one code path drives every episodic surface. */
  function epParts(list) {
    return (list || []).map(function (e, i) {
      var n = Number(e && (e.ep || e.n)) || (i + 1);
      return {
        n: n, s: Number(e && e.s) || 0,
        url: String((e && (e.url || e.file)) || ''),
        t: String((e && (e.title || e.name)) || ('Episode ' + n)).slice(0, 140),
        direct: !!(e && e.direct)
      };
    }).filter(function (p) { return p.url; }).sort(function (a, b) { return a.n - b.n; });
  }

  async function loadJavParts(it) {
    var page = it.page || it.url;
    var parts = [];
    try {
      var res = await SC.javEpisodes(page);
      parts = epParts(res && res.episodes);
    } catch (e) { parts = []; }
    if (!parts.length) parts = [{ n: 1, s: 0, url: page, t: 'Episode 1', direct: false }];
    if (st.current !== it) return;
    st.parts = parts;
    var host = document.getElementById('wadParts');
    if (host) host.innerHTML = partsHtml(parts);
    var playBtn = $('[data-wad-play]', detailEl);
    if (playBtn) playBtn.innerHTML = iconPlay() + ' Play E1';
  }

  async function loadAiParts(it) {
    var page = it.page || it.url;
    var parts = [];
    try {
      var res = await SC.aiEpisodes(page);
      parts = epParts(res && res.episodes);
    } catch (e) { parts = []; }
    if (!parts.length) parts = [{ n: 1, s: 0, url: page, t: 'Episode 1', direct: false }];
    if (st.current !== it) return;
    st.parts = parts;
    var host = document.getElementById('wadParts');
    if (host) host.innerHTML = partsHtml(parts);
    var playBtn = $('[data-wad-play]', detailEl);
    if (playBtn && parts.length > 1) playBtn.innerHTML = iconPlay() + ' Play E1';
  }

  async function loadParts(it) {
    if (!it.page && !it.url) return;
    if (it.kind === 'jav') return loadJavParts(it);
    if (it.kind === 'ai') return loadAiParts(it);
    var pageUrl = it.page || it.url;
    try {
      var html = await SC.fetchText(pageUrl, 18000);
      if (st.current !== it) return;
      var og = ogImage(html, pageUrl);
      if (og && (!it.poster || /-\d{2,4}x\d{2,4}\.(?:jpe?g|webp|png)/i.test(it.poster))) {
        it.poster = og;
        applyCustomPoster(it);
      }
      var parts = [];
      try { parts = SC.partsFromHtml(html, pageUrl, { media: true }) || []; } catch (e) { parts = []; }
      parts = (parts || []).filter(function (p) { return p && p.url; });
      if (parts.length < 2) {
        var loose = looseParts(html, pageUrl);
        if (loose.length >= 2) parts = loose;
      }
      if (parts.length < 2) {
        var show = seriesLink(html, pageUrl);
        if (show) {
          try {
            var html2 = await SC.fetchText(show, 18000);
            if (st.current !== it) return;
            var more = (SC.partsFromHtml(html2, show, { media: true }) || []).filter(function (p) { return p && p.url; });
            if (more.length < 2) more = looseParts(html2, show);
            if (more.length >= 2) {
              var hasFirst = more.some(function (p) { return Number(p.n) === 1; });
              if (!hasFirst) more.unshift({ n: 1, s: 0, url: pageUrl, t: 'Episode 1' });
              more.sort(function (a, b) { return (Number(a.n) || 0) - (Number(b.n) || 0); });
              parts = more;
            }
          } catch (e) {}
        }
      }
      st.parts = parts;
      var host = document.getElementById('wadParts');
      if (host) host.innerHTML = partsHtml(parts);
      var playBtn = $('[data-wad-play]', detailEl);
      if (playBtn && parts.length > 1) playBtn.innerHTML = iconPlay() + ' Play E1';
    } catch (e) {
      var h = document.getElementById('wadParts');
      if (h) h.innerHTML = '<div class="wa-note">Episode list unavailable. Play opens the source page.</div>';
    }
  }

  function onDetailClick(e) {
    if (e.target.closest('[data-wad-back]')) { closeDetail(); return; }
    var it = st.current;
    if (!it) return;
    if (e.target.closest('[data-wad-play]')) {
      if (it.kind === 'tmdb' || it.kind === 'country') {
        if (it.mt === 'tv') { st.ep = 1; playTmdb(it); }
        else playTmdb(it);
      } else if (st.parts && st.parts.length) {
        var p = st.parts[0];
        playCustom(it, p.url, p.t || it.t);
      } else {
        playCustom(it, it.page || it.url, it.t);
      }
      return;
    }
    if (e.target.closest('[data-wad-src]')) {
      if (it.kind === 'tmdb' || it.kind === 'country') openSources(it);
      else if (it.page) App.openWeb(it.page, it.t);
      return;
    }
    var sc = e.target.closest('[data-wad-season]');
    if (sc) {
      st.ep = 1;
      loadSeason(it, Number(sc.getAttribute('data-wad-season')) || 1);
      return;
    }
    var eb = e.target.closest('[data-wad-ep]');
    if (eb) {
      st.ep = Number(eb.getAttribute('data-wad-ep')) || 1;
      $$('[data-wad-ep]', detailEl).forEach(function (x) { x.classList.toggle('on', x === eb); });
      playTmdb(it);
      return;
    }
    var pb = e.target.closest('[data-wad-part]');
    if (pb) {
      var idx = Number(pb.getAttribute('data-wad-part')) || 0;
      var part = st.parts[idx];
      if (part) {
        if (part.direct) App.playDirect(part.url, part.t || it.t || '', { hls: /\.m3u8/i.test(part.url), ref: it.page || it.url });
        else playCustom(it, part.url, part.t || (it.t + ' · E' + (part.n || idx + 1)));
      }
      return;
    }
  }

  // ---------------------------------------------------------- resolution
  function unescapeMedia(s) {
    return String(s || '').replace(/\\\//g, '/').replace(/\\u0026/g, '&').replace(/&amp;/g, '&').replace(/\\u003d/g, '=');
  }

  function findMedia(html) {
    var norm = unescapeMedia(html);
    var re = /https?:\/\/[^\s"'<>\\]+?\.(?:mp4|webm|m3u8)(?:\?[^\s"'<>\\]*)?/gi;
    var best = null, bestScore = -1, m;
    while ((m = re.exec(norm))) {
      var u = m[0];
      if (/pixel|blank|spacer|thumb|preview\./i.test(u) && !/preview\.mp4/i.test(u)) continue;
      var sc = 0;
      if (/\.m3u8/i.test(u)) sc += 3;
      if (/master|playlist/i.test(u)) sc += 2;
      if (/1080/.test(u)) sc += 2;
      if (/720/.test(u)) sc += 1;
      if (u.length > 40) sc += 1;
      if (sc > bestScore) { bestScore = sc; best = u; }
    }
    return best;
  }

  function findIframe(html, base) {
    var norm = unescapeMedia(html);
    var m = norm.match(/<iframe[^>]+(?:data-src|src)=["']([^"']+)["']/i);
    if (!m) return '';
    try { return new URL(m[1], base).href; } catch (e) { return ''; }
  }

  async function playCustom(it, url, title) {
    if (it.kind === 'yt' || it.vid) {
      App.openWeb(location.origin + '/yt.html?id=' + enc(it.vid || '') + '&t=' + enc(it.t || ''),
        it.t || 'YouTube');
      return;
    }
    if (it.kind === 'arc' && it.arc) { playArchive(it); return; }
    url = url || it.page || it.url;
    if (!url) { App.toast('No source page for this title'); return; }
    var btns = $$('[data-wad-play]', detailEl);
    btns.forEach(function (b) { b.textContent = 'Preparing stream…'; b.disabled = true; });
    try {
      /* JAV plays through its own resolver BEFORE the generic sniffer: the
         stream sits behind a player payload + a JSON hop that /extract cannot
         follow, but the resolver returns a signed native HLS playlist. */
      if (it.kind === 'jav' || /(?:^|\.)123av\.com$/i.test(hostOf(url) || '') || /\/\/sadie-shop\.site\/e\//i.test(url)) {
        try {
          var jr = await SC.javResolve(url);
          if (jr && jr.file) {
            App.playDirect(jr.file, title || it.t, { hls: jr.type === 'hls', ref: jr.ref || url, page: url });
            return;
          }
        } catch (e) {}
      }
      /* A URL that already names a media file never needs the sniffer: play it
         natively and let the player's own fallback ladder handle the format. */
      if (/\.(?:m3u8|mp4|webm|mkv)(?:[?#]|$)/i.test(url)) {
        App.playDirect(url, title || it.t, { hls: /\.m3u8/i.test(url), ref: it.page || url, page: url });
        return;
      }
      if (it.kind === 'htv') {
        try {
          var nh = await SC.nhStream(url);
          if (nh && nh.url) { App.playDirect(nh.url, title || it.t, { ref: 'https://nhplayer.com/', page: url }); return; }
        } catch (e) {}
      }
      var ex = null;
      try { ex = await SC.extract(url, title || it.t, 25000); } catch (e) { ex = null; }
      if (ex && ex.ok !== false) {
        var alt = (ex.play && ex.play !== ex.file) ? ex.play : "";
        if (ex.type === 'hls' && (ex.play || ex.file)) {
          App.playDirect(ex.play || ex.file, title || it.t,
            { hls: true, ref: ex.ref || url, fallback: (ex.file && ex.file !== (ex.play || ex.file)) ? ex.file : alt, embed: ex.embed || ex.isolated || '', page: url });
          return;
        }
        if (ex.type === 'direct' && (ex.file || ex.play)) {
          App.playDirect(ex.file || ex.play, title || it.t,
            { ref: ex.ref || url, fallback: alt, embed: ex.embed || ex.isolated || '', page: url });
          return;
        }
        if (ex.type === 'embed' && ex.embed) {
          App.openWeb(ex.embed, title || it.t);
          return;
        }
      }
      var html = await SC.fetchText(url, 18000);
      var media = findMedia(html);
      if (media) {
        App.playDirect(media, title || it.t, { hls: /\.m3u8/i.test(media), ref: url, page: url });
        return;
      }
      var frame = findIframe(html, url);
      if (frame) { App.openWeb(frame, title || it.t); return; }
      App.openWeb(url, title || it.t);
    } catch (e) {
      App.openWeb(url, title || it.t);
    } finally {
      btns.forEach(function (b) { b.disabled = false; });
      var cur = st.current;
      if (cur) {
        var series = cur.isSeries || cur.parts > 0 || /^(xs|kat|kd|hd|ai|htv)$/.test(cur.kind || '');
        btns.forEach(function (b) { b.innerHTML = iconPlay() + ' ' + (series ? 'Play E1' : 'Play now'); });
      }
    }
  }

  async function playArchive(it) {
    App.toast('Preparing archive stream…');
    try {
      var j = await getJson('/page?url=' + enc('https://archive.org/metadata/' + it.arc));
      var files = (j && j.files) || [];
      var vids = files.filter(function (f) {
        return /\.(mp4|webm|ogv|mkv)$/i.test(f.name || '') && !/thumb|sample|preview/i.test(f.name || '');
      }).sort(function (a, b) {
        function score(f) {
          var s = 0;
          if (/\.mp4$/i.test(f.name)) s += 5;
          if (/512kb|h\.264|mpeg4/i.test(f.format || '')) s += 3;
          if (/\.mkv$/i.test(f.name)) s -= 2;
          return s;
        }
        return score(b) - score(a);
      });
      if (!vids.length) { App.openWeb('https://archive.org/details/' + it.arc, it.t); return; }
      var f = vids[0];
      var url = 'https://archive.org/download/' + it.arc + '/' + f.name.split('/').map(enc).join('/');
      App.playDirect(url, it.t, { ref: 'https://archive.org/details/' + it.arc });
    } catch (e) {
      App.openWeb('https://archive.org/details/' + it.arc, it.t);
    }
  }

  window.LIB = {
    appendRows: appendRows,
    openItem: openItem,
    openLive: openLive,
    openAdult: openAdult,
    openSources: openLibrarySources,
    searchAll: searchAll,
    rowsForTab: rowsForTab,
    cards: cards,
    back: function () {
      if (detailEl && !detailEl.classList.contains('hidden')) { closeDetail(); return true; }
      return false;
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

})();
