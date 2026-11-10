/* sources-hub.js - the complete SuperBox source directory.
   ---------------------------------------------------------------------------
   Every movie/TV, anime and manga site shipped in source.txt is listed here,
   tagged and searchable. The hub itself is data + a small renderer; opening a
   source hands the URL to the host app, which mounts it inside the Shield
   tunnel (Electron iframe / Android WebView) so browsing never leaks around
   the VPN.

   Sources that expose a stable public API (MangaDex, Webtoons) also appear as
   native rows in reading.js; the hub always keeps the original site one tap
   away for anything that cannot be scraped reliably. */
(function () {
  'use strict';
  if (window.SOURCES_HUB) return;

  var S = [
    /* ---------------------------------------------------------- movies / TV */
    { id: 'netmirror', n: 'NetMirror', u: 'https://netmirror.plus/', k: 'movie', r: 'IN', note: 'Hindi + English movies and series' },
    { id: 'net77', n: 'Net77', u: 'https://net77.cc/home', k: 'movie', r: 'IN', note: 'Bollywood, Hollywood and web series' },
    { id: 'tubi', n: 'Tubi', u: 'https://tubitv.com/', k: 'movie', r: 'US', note: 'Free ad-supported movies and TV' },
    { id: 'pluto', n: 'Pluto TV', u: 'https://pluto.tv/', k: 'movie', r: 'US', note: 'Free live channels and on demand' },
    { id: 'plex', n: 'Plex Watch', u: 'https://watch.plex.tv/en-GB', k: 'movie', r: 'UK', note: 'Free movies, series and live TV' },
    { id: 'minitv', n: 'Amazon MiniTV', u: 'https://www.amazon.in/minitv', k: 'movie', r: 'IN', note: 'Free Indian shows and films' },
    { id: 'olamovies', n: 'OlaMovies', u: 'https://v6.olamovies.mov/', k: 'movie', r: 'IN', note: 'HD movie index, multi-language' },
    { id: 'iplayer', n: 'BBC iPlayer', u: 'https://www.bbc.co.uk/iplayer', k: 'movie', r: 'UK', note: 'UK licence required for playback' },
    { id: 'itv', n: 'ITVX', u: 'https://www.itv.com/', k: 'movie', r: 'UK', note: 'British series, soaps and films' },
    { id: '9now', n: '9Now', u: 'https://www.9now.com.au/', k: 'movie', r: 'AU', note: 'Australian free-to-air streaming' },
    { id: 'sling', n: 'Sling', u: 'https://watch.sling.com/dashboard/home', k: 'movie', r: 'US', note: 'Live cable and on demand' },
    { id: 'filmzie', n: 'Filmzie', u: 'https://filmzie.com/', k: 'movie', r: 'UK', note: 'Indie films and classics' },
    { id: '7reels', n: '7Reels', u: 'https://7reels.cc/', k: 'movie', r: 'IN', note: 'Hindi dubbed catalogue' },
    { id: 'trueid', n: 'TrueID', u: 'https://www.trueid.net/watch/th-en/all-movie', k: 'movie', r: 'TH', note: 'Thai and Asian movies' },
    { id: 'supernova', n: 'SuperNova', u: 'https://supernova.to/', k: 'movie', r: 'US', note: 'Movies, series and anime' },
    { id: 'stirr', n: 'Stirr', u: 'https://stirr.com/', k: 'movie', r: 'US', note: 'Free live TV and movies' },
    { id: 'kanopy', n: 'Kanopy', u: 'https://www.kanopy.com/', k: 'movie', r: 'US', note: 'Library card streaming' },
    { id: 'hoopla', n: 'Hoopla', u: 'https://www.hoopladigital.com/', k: 'movie', r: 'US', note: 'Library card movies, comics and audio' },
    { id: 'fawesome', n: 'FAWESOME', u: 'https://fawesome.tv/', k: 'movie', r: 'US', note: 'Free movies and series' },
    { id: 'freemoviescinema', n: 'Free Movies Cinema', u: 'https://freemoviescinema.com/', k: 'movie', r: 'US', note: 'Public-domain and indie films' },
    { id: 'bigflix', n: 'BigFlix', u: 'https://www.bigflix.pro/', k: 'movie', r: 'IN', note: 'Indian regional cinema' },
    { id: 'shemaroome', n: 'ShemarooMe', u: 'https://www.shemaroome.com/', k: 'movie', r: 'IN', note: 'Bollywood and Gujarati theatre' },
    { id: 'yupptv', n: 'YuppTV FAST', u: 'https://www.yupptv.com/fast-tv', k: 'movie', r: 'IN', note: 'Indian FAST channels' },

    /* ---------------------------------------------------------------- manga */
    { id: 'mangadex', n: 'MangaDex', u: 'https://mangadex.org/', k: 'manga', r: 'Global', note: 'Open API, millions of chapters', native: true },
    { id: 'webtoons', n: 'WEBTOON', u: 'https://www.webtoons.com/en/', k: 'manga', r: 'Global', note: 'Official vertical comics', native: true },
    { id: 'asura', n: 'Asura Scans', u: 'https://asurascans.com/comics', k: 'manga', r: 'Global', note: 'Manhwa and manhua' },
    { id: 'flame', n: 'Flame Comics', u: 'https://flamecomics.xyz/', k: 'manga', r: 'Global', note: 'Manhwa translations' },
    { id: 'vortex', n: 'Vortex Scans', u: 'https://vortexscans.org/', k: 'manga', r: 'Global', note: 'Manhwa and manhua' },
    { id: 'hivetoons', n: 'HiveToons', u: 'https://hivetoons.org/series/?genres=%2B4', k: 'manga', r: 'Global', note: 'Manhwa, manhua and comics' },
    { id: 'comix', n: 'Comix', u: 'https://comix.to/', k: 'manga', r: 'Global', note: 'Aggregated manga and manhwa' },
    { id: 'manhuaus', n: 'ManhuaUS', u: 'https://manhuaus.club/', k: 'manga', r: 'Global', note: 'Manhua and manhwa' },
    { id: 'nelomanga', n: 'NeloManga', u: 'https://www.nelomanga.net/', k: 'manga', r: 'Global', note: 'Manga, manhwa and manhua' },
    { id: 'tappytoon', n: 'Tappytoon', u: 'https://www.tappytoon.com/', k: 'manga', r: 'Global', note: 'Official manhwa (paid chapters)' },
    { id: 'tapas', n: 'Tapas', u: 'https://tapas.io/', k: 'manga', r: 'Global', note: 'Webcomics and novels' },
    { id: 'mangafire', n: 'MangaFire', u: 'https://mangafire.to/', k: 'manga', r: 'Global', note: 'Large manga index' },
    { id: 'toonsutra', n: 'ToonSutra', u: 'https://www.toonsutra.com/manhwa', k: 'manga', r: 'IN', note: 'Indian comics and manhwa' },
    { id: 'hentai20', n: 'Hentai20', u: 'https://hentai20.io/', k: 'manga', r: 'Global', note: 'Adults only', adult: true },

    /* ---------------------------------------------------------------- anime */
    { id: 'aniwaves', n: 'AniWaves', u: 'https://aniwaves.tv/home', k: 'anime', r: 'Global', note: 'Anime streams and schedule' },
    { id: '9anime', n: '9Anime', u: 'https://9anime.si/', k: 'anime', r: 'Global', note: 'Sub and dub catalogue' },
    { id: 'animevillage', n: 'AnimeVillage', u: 'https://animevillage.org/', k: 'anime', r: 'Global', note: 'Anime episodes and movies' },
    { id: 'miruro', n: 'Miruro', u: 'https://www.miruro.cx/', k: 'anime', r: 'Global', note: 'Fast anime streaming' },
    { id: 'aniwatch', n: 'AniWatch', u: 'https://aniwatchtv.ws/home', k: 'anime', r: 'Global', note: 'Anime with dubs' },
    { id: 'yomi', n: 'Yomi', u: 'https://yomi.to/', k: 'anime', r: 'Global', note: 'Anime and manga' },
    { id: 'aniflix', n: 'AniFlix', u: 'https://aniflix.uno/', k: 'anime', r: 'Global', note: 'Anime catalogue' },
    { id: 'animixplay', n: 'AniMixPlay', u: 'https://animixplay.com.ro/', k: 'anime', r: 'Global', note: 'Anime aggregator' },
    { id: 'hianimes', n: 'HiAnime', u: 'https://hianimes.se/home', k: 'anime', r: 'Global', note: 'Anime sub and dub' }
  ];

  var KINDS = [
    { id: 'movie', t: 'Movies & TV', s: 'Free, ad-supported and regional streaming sites' },
    { id: 'anime', t: 'Anime', s: 'Sub and dub catalogues from around the web' },
    { id: 'manga', t: 'Manga & Manhwa', s: 'Official and scanlation readers' }
  ];

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function hostOf(u) {
    try { return new URL(u).host.replace(/^www\./, ''); } catch (e) { return u; }
  }
  function open(item, opts) {
    if (!item) return;
    if (opts && opts.open) { opts.open(item.u, item.n); return; }
    if (window.SBAndroid && window.SBAndroid.openWeb) {
      window.SBAndroid.openWeb(item.u, item.n);
      return;
    }
    try { window.open(item.u, '_blank', 'noopener'); } catch (e) {}
  }

  function style() {
    if (document.getElementById('sbSourcesCss')) return;
    var s = document.createElement('style');
    s.id = 'sbSourcesCss';
    s.textContent = [
      '.sh-wrap{max-width:1500px;margin:0 auto;padding:22px 28px 80px}',
      '.sh-head h1{font-size:clamp(28px,4vw,46px);letter-spacing:-.03em;margin:0 0 6px}',
      '.sh-head p{color:#9aa0aa;margin:0 0 18px;font-size:14px}',
      '.sh-tools{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 26px}',
      '.sh-search{flex:1;min-width:220px;background:#14161b;border:1px solid #242832;color:#e9eaee;border-radius:12px;padding:12px 14px;font-size:14px;outline:none}',
      '.sh-search:focus{border-color:#ffc105}',
      '.sh-chip{border:1px solid #242832;background:#14161b;color:#c7cbd4;border-radius:999px;padding:9px 15px;font-size:12.5px;cursor:pointer}',
      '.sh-chip.on{background:#ffc105;border-color:#ffc105;color:#111;font-weight:700}',
      '.sh-group{margin:0 0 34px}',
      '.sh-group h2{font-size:17px;letter-spacing:.01em;margin:0 0 4px}',
      '.sh-group .sub{color:#7d838e;font-size:12.5px;margin:0 0 16px}',
      '.sh-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px}',
      '.sh-card{display:flex;gap:12px;align-items:center;text-align:left;background:#111318;border:1px solid #20242d;border-radius:14px;padding:13px 14px;cursor:pointer;color:inherit;transition:border-color .15s,transform .15s}',
      '.sh-card:hover{border-color:#3a3f4c;transform:translateY(-1px)}',
      '.sh-ava{width:44px;height:44px;border-radius:11px;display:grid;place-items:center;font-weight:800;font-size:17px;color:#111;flex:0 0 auto;background:linear-gradient(135deg,#ffc105,#ff8a00)}',
      '.sh-card[data-k="anime"] .sh-ava{background:linear-gradient(135deg,#7ee2ff,#4b7bff)}',
      '.sh-card[data-k="manga"] .sh-ava{background:linear-gradient(135deg,#ff9ae0,#a25bff)}',
      '.sh-card[data-adult="1"] .sh-ava{background:#2b2b2b;color:#ff5252}',
      '.sh-info{min-width:0;flex:1}',
      '.sh-info b{display:block;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.sh-info span{display:block;font-size:11.5px;color:#858b96;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.sh-go{font-size:18px;color:#5b616d}',
      '.sh-empty{color:#8b909a;padding:30px 4px}',
      '@media(max-width:640px){.sh-wrap{padding:16px 14px 90px}.sh-grid{grid-template-columns:1fr 1fr;gap:9px}.sh-card{padding:10px}.sh-ava{width:36px;height:36px;font-size:14px}.sh-info b{font-size:12.5px}.sh-info span{font-size:10.5px}}'
    ].join('\n');
    document.head.appendChild(s);
  }

  function card(item) {
    var letter = (item.n || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 1).toUpperCase() || '?';
    return '<button class="sh-card" type="button" data-src="' + esc(item.id) + '" data-k="' + esc(item.k) + '"' +
      (item.adult ? ' data-adult="1"' : '') + '>' +
      '<span class="sh-ava">' + (item.adult ? '18' : esc(letter)) + '</span>' +
      '<span class="sh-info"><b>' + esc(item.n) + '</b><span>' + esc(hostOf(item.u)) + ' · ' + esc(item.note || '') + '</span></span>' +
      '<span class="sh-go">›</span></button>';
  }

  function render(host, opts) {
    if (!host) return;
    style();
    opts = opts || {};
    var state = { q: '', kind: 'all' };
    host.innerHTML = '<div class="sh-wrap">' +
      '<div class="sh-head"><h1>Sources</h1><p>Every catalogue SuperBox ships. Streaming and browsing stay inside the Shield tunnel.</p></div>' +
      '<div class="sh-tools"><input class="sh-search" id="shSearch" type="search" placeholder="Search sources, countries, genres..." autocomplete="off">' +
      '<button class="sh-chip on" data-kind="all">All</button>' +
      KINDS.map(function (k) { return '<button class="sh-chip" data-kind="' + k.id + '">' + esc(k.t) + '</button>'; }).join('') +
      '</div><div id="shBody"></div></div>';

    var body = host.querySelector('#shBody');

    function paint() {
      var q = state.q.toLowerCase();
      var list = S.filter(function (x) {
        if (state.kind !== 'all' && x.k !== state.kind) return false;
        if (!q) return true;
        return (x.n + ' ' + x.note + ' ' + x.r + ' ' + hostOf(x.u)).toLowerCase().indexOf(q) >= 0;
      });
      if (!list.length) {
        body.innerHTML = '<div class="sh-empty">No source matches that search.</div>';
        return;
      }
      var html = '';
      KINDS.forEach(function (k) {
        var group = list.filter(function (x) { return x.k === k.id; });
        if (!group.length) return;
        html += '<section class="sh-group"><h2>' + esc(k.t) + ' <span style="color:#5f6570;font-weight:400">' + group.length + '</span></h2>' +
          '<p class="sub">' + esc(k.s) + '</p><div class="sh-grid">' + group.map(card).join('') + '</div></section>';
      });
      body.innerHTML = html;
    }

    function find(id) {
      for (var i = 0; i < S.length; i++) if (S[i].id === id) return S[i];
      return null;
    }

    host.querySelector('#shSearch').addEventListener('input', function (e) {
      state.q = e.target.value.trim();
      paint();
    });
    host.querySelectorAll('.sh-chip').forEach(function (b) {
      b.addEventListener('click', function () {
        state.kind = b.getAttribute('data-kind');
        host.querySelectorAll('.sh-chip').forEach(function (x) { x.classList.toggle('on', x === b); });
        paint();
      });
    });
    body.addEventListener('click', function (e) {
      var b = e.target.closest('[data-src]');
      if (!b) return;
      var item = find(b.getAttribute('data-src'));
      if (!item) return;
      if (item.adult) {
        var ok = false;
        try { ok = window.confirm('This source is for adults only (18+). Continue?'); } catch (err) {}
        if (!ok) return;
      }
      open(item, opts);
    });
    paint();
  }

  window.SOURCES_HUB = {
    all: S,
    kinds: KINDS,
    render: render,
    open: open,
    byKind: function (k) { return S.filter(function (x) { return x.k === k; }); }
  };
})();
