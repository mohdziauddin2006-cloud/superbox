/* vault.js - the SuperBox Vault catalogue layer for the Android app.
   ---------------------------------------------------------------------------
   The Windows build ships two catalogues: the Spotlight catalogue and the
   extended Vault library (TMDB/AniList rows, XMaal web series, KatMovieHD,
   KDramasMaza, archive.org cartoons, the 18+ vault, live TV and the ad-free
   Tube). This file mounts the Vault in the mobile UI, reusing the packaged
   sources.js/libraries.js data and scrapers.
   Streams that resolve to a real MP4/HLS play in the native SuperBox player;
   provider shells that cannot be extracted open in the in-app web player. */
(function () {
  'use strict';
  if (window.WA) return;

  var App = window.SBApp;
  var Z = window.ZAI || {};
  var SC = window.SC || {};
  var S = (App && App.state) || {};
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var enc = function (v) { return encodeURIComponent(String(v == null ? '' : v)); };
  var esc = App.esc;

  var items = {};
  var seq = 0;
  var st = {
    section: 'home', sub: 'jav', token: 0, current: null, tmdb: null,
    season: 1, ep: 1, parts: [], partIdx: 0, loading: false
  };
  var liveChs = [];
  var liveGroup = 0;
  var drawer, detailEl;

  var SECTIONS = {
    home: { t: 'The Vault', s: 'Cinema, series, anime and live TV — one infinite library.', kicker: 'SuperBox Vault' },
    movie: { t: 'Movies', s: 'Blockbusters, Indian cinema and world films', kicker: 'SuperBox Vault' },
    tv: { t: 'Series', s: 'Bingeable dramas, sitcoms and short series', kicker: 'SuperBox Vault' },
    webseries: { t: 'Web Series', s: 'Desi and Indian web series, A-Z', kicker: 'SuperBox Vault' },
    kdrama: { t: 'K-Drama', s: 'Korean drama, Hindi-dubbed and more', kicker: 'SuperBox Vault' },
    anime: { t: 'Anime', s: 'Trending, top rated and anime movies', kicker: 'SuperBox Vault' },
    kids: { t: 'Kids', s: 'Family films, animation and kids TV', kicker: 'SuperBox Vault' },
    adult: { t: '18+ Vault', s: 'JAV, Eporner, Rule34, MMS, hentai and more', kicker: 'Adults only' },
    cartoons: { t: 'Cartoons', s: 'Classic animation from archive.org', kicker: 'SuperBox Vault' },
    livetv: { t: 'Live TV', s: 'Free channels from around the world', kicker: 'SuperBox Vault' },
    tube: { t: 'Tube', s: 'Ad-free YouTube: music, tech, comedy and more', kicker: 'SuperBox Vault' }
  };

  var DRAWER = [
    { title: 'SuperBox', items: [
      { id: 'home', label: 'Spotlight', note: 'SuperBox picks', icon: '✦' },
      { id: 'movies', label: 'Movies', note: 'Cinema', icon: '▤' },
      { id: 'series', label: 'Series', note: 'Episodic', icon: '▥' },
      { id: 'anime', label: 'Anime', note: 'Animation', icon: '✧' },
      { id: 'me', label: 'Me', note: 'Settings', icon: '◉' }
    ] },
    { title: 'SuperBox Vault', vault: true, items: [
      { id: 'wa:home', label: 'Home', note: 'The infinite library', icon: '∞' },
      { id: 'wa:movie', label: 'Movies', note: 'TMDB', icon: '▤' },
      { id: 'wa:tv', label: 'Series', note: 'TMDB', icon: '▥' },
      { id: 'wa:webseries', label: 'Web Series', note: 'XMaal · KatMovieHD', icon: '▦' },
      { id: 'wa:kdrama', label: 'K-Drama', note: 'KDramasMaza', icon: '◈' },
      { id: 'wa:kids', label: 'Kids', note: 'Family + animation', icon: '☺' },
      { id: 'wa:adult', label: '18+', note: 'The vault', icon: '!' },
      { id: 'wa:cartoons', label: 'Cartoons', note: 'archive.org', icon: '◐' },
      { id: 'wa:livetv', label: 'Live TV', note: 'iptv-org · Free-TV', icon: '◉' },
      { id: 'wa:tube', label: 'Tube', note: 'YouTube, ad-free', icon: '▶' }
    ] }
  ];

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
    return '<button class="card wa-card" data-wa="' + id + '" aria-label="' + esc(it.t) + '">' +
      '<div class="card-poster">' +
      '<span class="ph">' + esc(initials(it.t)) + '</span>' +
      (it.poster ? '<img src="' + esc(img(it.poster)) + '" alt="' + esc(it.t) + '" loading="lazy" onerror="this.remove()">' : '') +
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
    var q = { new: 'japanese', hot: 'japanese', recent: 'japanese', today: 'japanese', week: 'japanese', top: 'japanese', uncensored: 'japanese uncensored', leaked: 'japanese uncensored', fc2: 'fc2' }[row.p] || 'japanese';
    return SC.epRow({ q: q, order: row.p === 'new' ? 'latest' : 'top-weekly', badge: row.badge || 'JAV' });
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

  // ---------------------------------------------------------------- section view
  function headerHtml(sec) {
    var d = SECTIONS[sec] || SECTIONS.home;
    var search = '<div class="wa-searchwrap"><div class="wa-search">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.2-3.2"></path></svg>' +
      '<input id="waSearchInput" type="search" autocomplete="off" placeholder="Search in ' + esc(d.t) + '...">' +
      '<button id="waSearchGo" aria-label="Search">Go</button>' +
      '</div></div>';
    if (sec === 'home') {
      return '<div class="page-head wa-head wa-vault-hero">' +
        '<div class="wa-vault-glow"></div>' +
        '<div class="wa-vault-kicker"><span class="wa-aura-dot"></span>SuperBox Vault</div>' +
        '<h1 class="page-title wa-vault-title">The Vault<span class="wa-vault-inf">∞</span></h1>' +
        '<div class="page-sub wa-vault-sub">Cinema, series, anime and live TV — one infinite library.</div>' +
        '<div class="wa-srcbar"><span class="wa-srcbar-label">Sources</span>' +
        '<span>TMDB</span><span>AniList</span><span>archive.org</span>' +
        '<button data-wa-sources>All sources</button></div>' +
        search.replace('wa-searchwrap', 'wa-searchwrap wa-vault-search') +
        '</div>';
    }
    return '<div class="page-head wa-head">' +
      '<div class="page-kicker">' + esc(d.kicker) + '</div>' +
      '<h1 class="page-title">' + esc(d.t) + '</h1>' +
      '<div class="page-sub">' + esc(d.s) + '</div>' +
      search + '</div>';
  }

  function rowShell(label, n) {
    return '<section class="section wa-row" data-row="' + n + '">' +
      '<div class="section-head"><h2>' + esc(label) + '</h2><span class="wa-count">…</span></div>' +
      '<div class="row-track wa-track">' + skeletonCards(5) + '</div></section>';
  }

  function skeletonCards(n) {
    var s = '';
    for (var i = 0; i < n; i++) s += '<div class="sk-card wa-sk"><div class="sk sk-poster"></div><div class="sk sk-line"></div><div class="sk sk-line short"></div></div>';
    return s;
  }

  /* Desktop sections can hold 60 rows (Eporner). A phone only needs the first
     dozen to feel rich, so paint in batches with an explicit "show more". */
  var ROW_BATCH = 12;
  function paintBatched(host, rows, token) {
    var shown = 0;
    function more() {
      var old = document.getElementById('waMoreRows');
      if (old) old.remove();
      var next = rows.slice(shown, shown + ROW_BATCH);
      shown += next.length;
      if (next.length) paintRows(host, next, token);
      var left = rows.length - shown;
      if (left > 0) {
        var b = document.createElement('button');
        b.id = 'waMoreRows';
        b.className = 'wa-more';
        b.textContent = 'Show more (' + left + ' rows)';
        b.onclick = more;
        host.appendChild(b);
      }
    }
    more();
  }

  function paintRows(host, rows, token) {
    if (!rows.length) {
      host.innerHTML += '<div class="empty"><b>Nothing here yet</b>This section has no rows configured.</div>';
      return;
    }
    var queue = [];
    rows.forEach(function (row, i) {
      var wrap = document.createElement('div');
      wrap.innerHTML = rowShell(row.t || 'Featured', i);
      var el = wrap.firstChild;
      host.appendChild(el);
      queue.push({ row: row, el: el });
    });
    var idx = 0, active = 0;
    function pump() {
      if (token !== st.token) return;
      while (active < 3 && idx < queue.length) {
        var q = queue[idx++];
        active++;
        loadOne(q, token).then(function () { active--; pump(); });
      }
    }
    pump();
  }

  async function loadOne(q, token) {
    var track = $('.wa-track', q.el);
    var count = $('.wa-count', q.el);
    var list = [];
    try {
      list = await loadRow(q.row);
      list = dedupe(list);
    } catch (e) {
      list = [];
    }
    if (token !== st.token || !q.el.isConnected) return;
    if (!list.length) {
      q.el.classList.add('wa-empty-row');
      if (count) count.textContent = 'unavailable';
      if (track) track.innerHTML = '<div class="wa-note">This source did not answer. Try another row or refresh.</div>';
      return;
    }
    if (count) count.textContent = list.length + ' titles';
    if (track) track.innerHTML = cards(list.slice(0, 24));
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

  function render(sec) {
    sec = sec || 'home';
    st.section = sec;
    st.token++;
    closeDrawer();
    closeDetail(true);
    if (S.playerOpen) { /* keep playback if the user opened the drawer */ }
    var token = st.token;
    var view = document.getElementById('view');
    view.innerHTML = headerHtml(sec) + '<div id="waBody"></div>';
    var body = document.getElementById('waBody');
    bindHeader(sec, token);
    if (sec === 'livetv') {
      renderLive(body, token);
      if (window.scrollTo) window.scrollTo(0, 0);
      return;
    }
    if (sec === 'adult') {
      body.innerHTML = vaultChips() + '<div id="waRows"></div>';
      $$('#waBody .chip').forEach(function (b) {
        b.onclick = function () {
          st.sub = b.getAttribute('data-vsub');
          var top = document.getElementById('waRows');
          if (top) top.innerHTML = '';
          $$('#waBody .chip').forEach(function (x) { x.classList.toggle('on', x === b); });
          paintBatched(top, rowsFor('adult', st.sub), token);
          window.scrollTo(0, 0);
        };
      });
      paintBatched(document.getElementById('waRows'), rowsFor('adult', st.sub), token);
    } else {
      body.innerHTML = '<div id="waRows"></div>';
      paintBatched(document.getElementById('waRows'), rowsFor(sec), token);
    }
    if (window.scrollTo) window.scrollTo(0, 0);
  }

  function vaultChips() {
    return '<div class="chips wa-vaultchips">' + (Z.VAULT_GROUPS || []).map(function (g) {
      return '<button class="chip' + (g.id === st.sub ? ' on' : '') + '" data-vsub="' + esc(g.id) + '">' + esc(g.t) + '</button>';
    }).join('') + '</div>';
  }

  function bindHeader(sec, token) {
    var input = document.getElementById('waSearchInput');
    var go = document.getElementById('waSearchGo');
    if (!input) return;
    function run() {
      var q = input.value.trim();
      if (!q) return;
      search(q, sec, token);
    }
    if (go) go.onclick = run;
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); run(); input.blur(); }
    });
  }

  // ---------------------------------------------------------------- search
  async function search(q, sec, token) {
    var body = document.getElementById('waBody');
    if (!body) return;
    body.innerHTML = '<div class="wa-searchhead"><b>Searching “' + esc(q) + '”…</b></div><div class="grid wa-grid">' + skeletonCards(8) + '</div>';
    var out = [];
    try {
      if (sec === 'tube') {
        out = await ytRow({ q: q, badge: 'RESULT' });
      } else if (sec === 'adult') {
        out = await SC.search(q, 'adult', st.sub);
      } else if (sec === 'webseries' || sec === 'kdrama') {
        out = await SC.search(q, sec);
      }
      var t = await tmdbSearch(q);
      out = t.concat(out);
    } catch (e) {}
    if (token !== st.token) return;
    if (!out.length) {
      body.innerHTML = '<div class="wa-searchhead"><b>No matches for “' + esc(q) + '”</b></div><div class="empty">Try a shorter title or a different spelling.</div>';
      return;
    }
    body.innerHTML = '<div class="wa-searchhead"><b>' + out.length + ' results for “' + esc(q) + '”</b></div>' +
      '<div class="grid wa-grid">' + cards(out) + '</div>';
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
          '<span class="wa-ch-logo">' + (c.logo ? '<img src="' + esc(img(c.logo)) + '" loading="lazy" onerror="this.remove()">' : '') + '</span>' +
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

  // ---------------------------------------------------------------- drawer
  function openLibrarySources() {
    var rows = [
      ['✦', 'Metadata & discovery', 'TMDB · AniList'],
      ['▤', 'Web series & cinema', 'XMaal · KatMovieHD · KDramasMaza · HindiDrama'],
      ['◐', 'Classic animation', 'Internet Archive (archive.org)'],
      ['▶', 'Tube', 'YouTube'],
      ['◉', 'Live TV', 'iptv-org · Free-TV'],
      ['!', '18+ Vault', 'Eporner · 123av · Rule34 · Hentaicity · Hentai.tv'],
      ['∞', 'Streams', 'Public embed providers, resolved at play time']
    ];
    var html = '<div class="sheet-title">Library sources</div>' +
      '<div class="sheet-sub">Every catalogue behind SuperBox Vault.</div>' +
      '<div class="wa-src-list">' + rows.map(function (r) {
        return '<div class="wa-src-item"><span class="wa-src-ic">' + r[0] + '</span>' +
          '<div><b>' + esc(r[1]) + '</b><span>' + esc(r[2]) + '</span></div></div>';
      }).join('') + '</div>' +
      '<div class="wa-src-note">SuperBox does not host media. Titles, artwork and streams stay with their sources and play inside the app.</div>';
    App.openSheet(html);
  }

  function buildDrawer() {
    drawer = document.createElement('div');
    drawer.id = 'waDrawer';
    drawer.className = 'wa-drawer hidden';
    drawer.setAttribute('aria-hidden', 'true');
    var html = '<div class="wa-drawer-back"></div><aside class="wa-drawer-panel">' +
      '<div class="wa-drawer-head"><div class="wa-drawer-logo">S</div><div class="wa-drawer-id"><b>SUPERBOX</b><span>Infinite library</span></div>' +
      '<button id="waDrawerClose" class="wa-x" aria-label="Close">✕</button></div>';
    DRAWER.forEach(function (g) {
      html += '<div class="wa-drawer-group' + (g.vault ? ' wa-drawer-vaultgroup' : '') + '">' +
        '<div class="wa-drawer-title' + (g.vault ? ' wa-vault-group' : '') + '">' +
        (g.vault ? '<span class="wa-vault-inf">∞</span>' : '') + esc(g.title) + '</div>' +
        (g.vault ? '<div class="wa-vault-sub">A separate universe, inside the box</div>' : '');
      g.items.forEach(function (it) {
        html += '<button class="wa-nav" data-nav="' + esc(it.id) + '">' +
          '<span class="wa-nav-ic">' + esc(it.icon) + '</span>' +
          '<span class="wa-nav-tx"><b>' + esc(it.label) + '</b><em>' + esc(it.note) + '</em></span>' +
          '<span class="wa-nav-arrow">›</span></button>';
      });
      if (g.vault) {
        html += '<button class="wa-src-link" data-wa-sources><span class="wa-src-link-ic">✧</span>' +
          '<span class="wa-nav-tx"><b>Library sources</b><em>Where every title comes from</em></span>' +
          '<span class="wa-nav-arrow">›</span></button>';
      }
      html += '</div>';
    });
    html += '<div class="wa-drawer-foot"><span>TMDB · AniList · archive.org · YouTube · IPTV</span><em>SuperBox does not host media.</em></div></aside>';
    drawer.innerHTML = html;
    document.body.appendChild(drawer);
    $('#waDrawerClose', drawer).onclick = closeDrawer;
    $('.wa-drawer-back', drawer).onclick = closeDrawer;
    $$('.wa-nav', drawer).forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-nav');
        closeDrawer();
        if (id.indexOf('wa:') === 0) App.switchTab(id);
        else App.switchTab(id);
      };
    });
    var src = $('.wa-src-link', drawer);
    if (src) src.onclick = function () {
      closeDrawer();
      setTimeout(openLibrarySources, 200);
    };
  }

  function openDrawer() {
    if (!drawer) buildDrawer();
    highlightDrawer();
    drawer.classList.remove('hidden');
    drawer.setAttribute('aria-hidden', 'false');
    var panel = $('.wa-drawer-panel', drawer);
    requestAnimationFrame(function () {
      if (panel) panel.scrollTop = 0;
      drawer.classList.add('open');
    });
  }
  function closeDrawer() {
    if (!drawer) return;
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    setTimeout(function () { if (drawer && !drawer.classList.contains('open')) drawer.classList.add('hidden'); }, 220);
  }
  function highlightDrawer() {
    if (!drawer) return;
    var active = S.tab || 'home';
    $$('.wa-nav', drawer).forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-nav') === active);
    });
  }

  // ---------------------------------------------------------------- boot
  function boot() {
    buildDrawer();
    var menu = document.getElementById('menuBtn');
    if (menu) menu.onclick = openDrawer;
    buildDetail();
    document.getElementById('view').addEventListener('click', function (e) {
      if (e.target.closest('[data-wa-sources]')) {
        openLibrarySources();
        return;
      }
      var c = e.target.closest('[data-wa]');
      if (c) {
        var it = items[c.getAttribute('data-wa')];
        if (it) openItem(it);
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
      '<div class="wad-poster">' + (poster ? '<img src="' + esc(img(poster)) + '" alt="" onerror="this.remove()">' : '') + '</div>' +
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
    var series = it.isSeries || it.parts > 0 || /^(xs|kat|kd|hd|ai|htv)$/.test(it.kind || '');
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
    if (box) box.innerHTML = '<img src="' + esc(img(it.poster)) + '" alt="" onerror="this.remove()">';
  }

  async function loadParts(it) {
    if (!it.page && !it.url) return;
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
      if (part) playCustom(it, part.url, part.t || (it.t + ' · E' + (part.n || idx + 1)));
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
      if (it.kind === 'htv') {
        try {
          var nh = await SC.nhStream(url);
          if (nh && nh.url) { App.playDirect(nh.url, title || it.t, { ref: 'https://nhplayer.com/' }); return; }
        } catch (e) {}
      }
      var ex = null;
      try { ex = await SC.extract(url, title || it.t, 40000); } catch (e) { ex = null; }
      if (ex && ex.ok !== false) {
        if (ex.type === 'hls' && (ex.play || ex.file)) {
          App.playDirect(ex.play || ex.file, title || it.t, { hls: true, ref: ex.ref || url });
          return;
        }
        if (ex.type === 'direct' && (ex.file || ex.play)) {
          App.playDirect(ex.file || ex.play, title || it.t, { ref: ex.ref || url });
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
        App.playDirect(media, title || it.t, { hls: /\.m3u8/i.test(media), ref: url });
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

  window.WA = {
    render: render,
    openDrawer: openDrawer,
    closeDrawer: closeDrawer,
    openItem: openItem,
    openSources: openLibrarySources,
    back: function () {
      if (drawer && drawer.classList.contains('open')) { closeDrawer(); return true; }
      if (detailEl && !detailEl.classList.contains('hidden')) { closeDetail(); return true; }
      return false;
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

})();
