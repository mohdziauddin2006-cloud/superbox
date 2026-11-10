(function () {
  "use strict";

  // ------------------------------------------------------------------ state
  var S = {
    tab: "home",
    home: null,
    homeAt: 0,
    homePromise: null,
    homeRows: [],
    banners: [],
    index: [],
    indexById: new Map(),
    indexLoading: false,
    trend: {},
    detailOpen: false,
    detailToken: 0,
    detailData: null,
    detailSeason: null,
    searchOpen: false,
    searchQuery: "",
    searchTimer: null,
    playerOpen: false,
    playback: null,
    sheetOpen: false,
    sheetHideTimer: null,
    heroTimer: null,
    controlsTimer: null,
    autoNextTimer: null,
    toastTimer: null,
    tabData: {},
    catByTab: { movies: "All", series: "All", anime: "All" },
    detailCache: new Map(),
    lastPlayed: null,
    quality: 0,
    autoplay: true,
    speed: 1,
    searchToken: 0
  };

  var hlsEngine = null;
  var dashEngine = null;
  var scriptPromises = {};
  var HOME_KEY = "sb.home.v2";

  var view = document.getElementById("view");
  var detail = document.getElementById("detail");
  var searchPage = document.getElementById("searchPage");
  var searchInput = document.getElementById("searchInput");
  var searchResults = document.getElementById("searchResults");
  var searchHint = document.getElementById("searchHint");
  var searchClear = document.getElementById("searchClear");
  var player = document.getElementById("player");
  var video = document.getElementById("video");
  var pUi = document.getElementById("pUi");
  var pTitle = document.getElementById("pTitle");
  var pSub = document.getElementById("pSub");
  var pPlay = document.getElementById("pPlay");
  var pPlayIcon = document.getElementById("pPlayIcon");
  var pSpinner = document.getElementById("pSpinner");
  var pCur = document.getElementById("pCur");
  var pDur = document.getElementById("pDur");
  var pSeek = document.getElementById("pSeek");
  var pQualityLabel = document.getElementById("pQualityLabel");
  var pAudioLabel = document.getElementById("pAudioLabel");
  var pSpeedLabel = document.getElementById("pSpeedLabel");
  var pEps = document.getElementById("pEps");
  var pError = document.getElementById("pError");
  var pErrorText = document.getElementById("pErrorText");
  var pGesture = document.getElementById("pGesture");
  var sheet = document.getElementById("sheet");
  var sheetContent = document.getElementById("sheetContent");
  var boot = document.getElementById("boot");
  var toastEl = document.getElementById("toast");

  var ICON = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l10-6.5-10-6.5Z"></path></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"></path></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"></path></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v5M12 8h.01"></path></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.2-3.2"></path></svg>',
    check: '<span class="opt-check">✓</span>'
  };

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function enc(v) { return encodeURIComponent(String(v == null ? "" : v)); }
  function mediaUrl(x) {
    if (!x) return "";
    if (typeof x === "string") return x;
    return x.url || x.src || x.cover || "";
  }
  function imgUrl(u) {
    if (!u) return "";
    return withToken("/img?u=" + encodeURIComponent(u).replace(/'/g, "%27").replace(/\)/g, "%29"));
  }
  function sbToken() {
    try { return window.__SB_TOKEN__ || ""; } catch (e) { return ""; }
  }
  function withToken(u) {
    if (!u || !sbToken()) return u;
    return u + (u.indexOf("?") >= 0 ? "&" : "?") + "t=" + enc(sbToken());
  }
  function cssUrl(u) { return u ? "url('" + imgUrl(u) + "')" : "none"; }

  /* Multi-tier image fallback: local /img proxy -> direct origin URL ->
     images.weserv.nl. The proxy supplies referer/cookies and the disk cache;
     direct covers proxies that refuse an upstream; weserv rescues CDNs that
     block the device IP. A card never ends up blank: after the last tier the
     <img> is removed and the initials placeholder underneath shows. */
  window.SBIMG = function (el) {
    if (!el || !el.isConnected) return;
    var src = el.getAttribute("src") || "";
    var orig = el.getAttribute("data-u") || "";
    if (!orig) {
      try {
        var abs = new URL(src, location.href);
        if (abs.pathname === "/img") {
          orig = abs.searchParams.get("u") || "";
          if (orig) el.setAttribute("data-u", orig);
        }
      } catch (e) {}
    }
    var n = parseInt(el.getAttribute("data-retry") || "0", 10) || 0;
    var chain;
    if (orig) {
      chain = [
        withToken("/img?u=" + encodeURIComponent(orig) + "&cv=2"),
        orig,
        "https://images.weserv.nl/?url=" + encodeURIComponent(String(orig).replace(/^https?:\/\//i, ""))
      ];
    } else {
      chain = [src];
    }
    var next = n + 1;
    if (next >= chain.length) { el.remove(); return; }
    el.setAttribute("data-retry", String(next));
    el.referrerPolicy = "no-referrer";
    var url = chain[next];
    setTimeout(function () {
      if (el.isConnected && url) el.src = url;
    }, 350 + n * 800);
  };
  function detailUrl(dp) { return "https://movieboxph.org/movies/" + String(dp || "").replace(/^\/+/, ""); }
  function fmtTime(t) {
    t = Number(t);
    if (!isFinite(t) || t < 0) t = 0;
    var h = Math.floor(t / 3600);
    var m = Math.floor((t % 3600) / 60);
    var s = Math.floor(t % 60);
    if (h > 0) return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
    return m + ":" + String(s).padStart(2, "0");
  }
  function fmtSize(n) {
    n = Number(n) || 0;
    if (!n) return "";
    if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(1) + " GB";
    return Math.round(n / (1024 * 1024)) + " MB";
  }
  function initials(t) {
    var clean = String(t || "").replace(/[^A-Za-z0-9 ]/g, " ").trim();
    if (!clean) return "SB";
    var w = clean.split(/\s+/);
    return (w[0].charAt(0) + (w[1] ? w[1].charAt(0) : "")).toUpperCase();
  }
  function cleanRow(t) {
    return String(t || "").replace(/^[\s\-–—:|]+/, "").replace(/\s+/g, " ").trim() || "Featured";
  }
  function num(v, d) {
    if (v === null || v === undefined || v === "") return d || 0;
    var n = Number(v);
    return isFinite(n) ? n : (d || 0);
  }
  function prefGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function prefSet(k, v) { try { localStorage.setItem(k, String(v)); } catch (e) {} }
  function prefDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(S.toastTimer);
    S.toastTimer = setTimeout(function () { toastEl.classList.remove("show"); }, 2400);
  }

  function lockBody() {
    var lock = S.detailOpen || S.searchOpen || S.playerOpen || S.sheetOpen;
    document.body.style.overflow = lock ? "hidden" : "";
  }

  // ---------------------------------------------------------------- network
  async function api(path) {
    var r = await fetch("/api/" + path, { cache: "no-store" });
    var text = await r.text();
    var j = null;
    try { j = JSON.parse(text); } catch (e) {}
    if (!r.ok || !j) throw new Error("SuperBox API " + r.status);
    return j;
  }

  function normSubject(x) {
    if (!x) return null;
    var s = x.subject || x;
    var id = s.subjectId || s.id;
    var dp = s.detailPath;
    if (!id || !dp) return null;
    var poster = mediaUrl(s.cover) || mediaUrl(s.poster) || mediaUrl(x.image);
    var still = mediaUrl(s.stills) || poster;
    var genre = s.genre;
    if (Array.isArray(genre)) genre = genre.join(", ");
    return {
      id: String(id),
      dp: String(dp),
      t: s.title || s.name || x.title || "",
      poster: poster,
      bg: still,
      year: String(s.releaseDate || "").slice(0, 4),
      rating: num(s.imdbRatingValue, 0) > 0 ? num(s.imdbRatingValue, 0).toFixed(1) : "",
      genre: String(genre || ""),
      country: String(s.countryName || ""),
      stype: num(s.subjectType, 0),
      desc: String(s.description || ""),
      appointment: s.appointmentDate || ""
    };
  }

  function mergeIndex(items) {
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || !it.id) continue;
      var cur = S.indexById.get(it.id);
      if (cur) {
        if (!cur.poster && it.poster) cur.poster = it.poster;
        if (!cur.bg && it.bg) cur.bg = it.bg;
        if (!cur.rating && it.rating) cur.rating = it.rating;
        if (!cur.genre && it.genre) cur.genre = it.genre;
        if (!cur.desc && it.desc) cur.desc = it.desc;
      } else {
        S.indexById.set(it.id, it);
        S.index.push(it);
      }
    }
    if (S.index.length > 900) {
      S.index = S.index.slice(S.index.length - 900);
      S.indexById.clear();
      S.index.forEach(function (x) { S.indexById.set(x.id, x); });
    }
  }

  function getItem(id) {
    var hit = S.indexById.get(String(id));
    if (hit) return hit;
    for (var i = 0; i < S.homeRows.length; i++) {
      var items = S.homeRows[i].items;
      for (var j = 0; j < items.length; j++) {
        if (items[j].id === String(id)) return items[j];
      }
    }
    return null;
  }

  function readHomeSnapshot() {
    try {
      var raw = localStorage.getItem(HOME_KEY);
      if (!raw) return null;
      var snap = JSON.parse(raw);
      if (!snap || !snap.data || !snap.data.operatingList) return null;
      return snap;
    } catch (e) {
      return null;
    }
  }

  function saveHomeSnapshot() {
    if (!S.home) return;
    try {
      localStorage.setItem(HOME_KEY, JSON.stringify({ at: S.homeAt, data: S.home }));
    } catch (e) {}
  }

  async function loadHome(force) {
    if (!force && !S.home) {
      var snap = readHomeSnapshot();
      if (snap) {
        S.home = snap.data;
        S.homeAt = num(snap.at, 0);
        buildHome();
      }
    }
    if (!force && S.home && Date.now() - S.homeAt < 300000) return S.home;
    if (S.homePromise) return S.homePromise;
    var hadPaint = !!S.home;
    S.homePromise = (async function () {
      var j = await api("home");
      if (!j || !j.data || !j.data.operatingList) throw new Error("Catalogue unavailable");
      S.home = j.data;
      S.homeAt = Date.now();
      buildHome();
      saveHomeSnapshot();
      return S.home;
    })();
    var refreshing = S.homePromise;
    if (hadPaint && !force) {
      // Instant paint from the local snapshot, then quietly refresh.
      refreshing.then(function () {
        if (S.homePromise === refreshing) S.homePromise = null;
        if (S.tab === "home" && window.scrollY < 80) {
          view.innerHTML = homeMarkup();
          startHero();
          paintLibRows("home");
        }
      }).catch(function () {
        if (S.homePromise === refreshing) S.homePromise = null;
      });
      return S.home;
    }
    try {
      return await refreshing;
    } finally {
      if (S.homePromise === refreshing) S.homePromise = null;
    }
  }

  function buildHome() {
    var home = S.home;
    var ops = (home && home.operatingList) || [];
    var banners = [];
    var rows = [];
    ops.forEach(function (op) {
      if (op.type === "BANNER" && op.banner && op.banner.items) {
        op.banner.items.slice(0, 10).forEach(function (b) {
          var it = normSubject(b.subject || b);
          if (!it) return;
          var wide = mediaUrl(b.image) || mediaUrl((b.subject || {}).stills) || it.poster;
          it.bg = wide || it.poster || it.bg;
          it.desc = String((b.subject || {}).description || b.description || it.desc || "");
          if (b.title) it.t = b.title;
          if (it.bg || it.poster) banners.push(it);
        });
      }
      if (op.type === "SUBJECTS_MOVIE" || op.type === "APPOINTMENT_LIST") {
        var items = [];
        (op.subjects || []).forEach(function (x) {
          var it = normSubject(x.subject || x);
          if (it) items.push(it);
        });
        items = dedupe(items);
        if (items.length) rows.push({ title: cleanRow(op.title), type: op.type, items: items });
      }
    });
    S.banners = dedupe(banners).slice(0, 9);
    S.homeRows = rows;
    mergeIndex(S.banners.slice());
    rows.forEach(function (r) { mergeIndex(r.items); });
  }

  function dedupe(items) {
    var seen = {};
    var out = [];
    (items || []).forEach(function (it) {
      if (!it || !it.id || seen[it.id]) return;
      seen[it.id] = 1;
      out.push(it);
    });
    return out;
  }

  async function loadTrending(page) {
    var key = String(page || 1);
    if (S.trend[key] && Date.now() - S.trend[key].at < 180000) return S.trend[key].items;
    var j = await api("trending?page=" + key + "&perPage=24&tabId=0");
    var list = (j && j.data && j.data.subjectList) || [];
    var items = list.map(normSubject).filter(Boolean);
    S.trend[key] = { at: Date.now(), items: items };
    mergeIndex(items);
    return items;
  }

  async function loadMoreIndex() {
    if (S.indexLoading || S.index.length > 500) return;
    S.indexLoading = true;
    try {
      var pages = await Promise.all([
        loadTrending(2).catch(function () { return []; }),
        loadTrending(3).catch(function () { return []; }),
        loadTrending(4).catch(function () { return []; })
      ]);
      pages.forEach(function (p) { mergeIndex(p); });
      if (S.searchOpen) renderSearch(searchInput.value.trim());
    } catch (e) {
    } finally {
      S.indexLoading = false;
    }
  }

  // ---------------------------------------------------------------- cards
  function tagFor(it) {
    if (it.stype === 1) return "MOVIE";
    if (it.stype === 7) return "SHORT";
    return "SERIES";
  }

  function card(it) {
    if (!it) return "";
    var tag = tagFor(it);
    var gold = it.stype === 1 ? "" : " gold";
    var meta = [];
    if (it.year) meta.push(it.year);
    if (it.genre) meta.push(String(it.genre).split(",")[0].trim());
    if (it.country) meta.push(it.country);
    return '<button class="card" data-id="' + esc(it.id) + '" aria-label="' + esc(it.t) + '">' +
      '<div class="card-poster">' +
      '<span class="ph">' + esc(initials(it.t)) + "</span>" +
      (it.poster ? '<img src="' + imgUrl(it.poster) + '" alt="' + esc(it.t) + '" loading="lazy" decoding="async" onerror="SBIMG(this)">' : "") +
      '<span class="card-tag' + gold + '">' + tag + "</span>" +
      (it.rating ? '<span class="card-rate">★ ' + esc(it.rating) + "</span>" : "") +
      "</div>" +
      '<div class="card-title">' + esc(it.t) + "</div>" +
      '<div class="card-meta">' + esc(meta.join(" · ")) + "</div>" +
      "</button>";
  }

  function cards(items) {
    return (items || []).map(card).join("");
  }

  // ---------------------------------------------------------------- home
  function skeletonHome() {
    return '<div class="sk sk-hero"></div>' +
      '<div class="chips">' +
      '<span class="sk" style="width:74px;height:32px;border-radius:999px"></span>' +
      '<span class="sk" style="width:70px;height:32px;border-radius:999px"></span>' +
      '<span class="sk" style="width:62px;height:32px;border-radius:999px"></span>' +
      '<span class="sk" style="width:58px;height:32px;border-radius:999px"></span>' +
      "</div>" +
      skeletonRow("Trending Now") + skeletonRow("SuperBox Cinema") + skeletonRow("Bollywood");
  }

  function skeletonRow(label) {
    var s = '<section class="section"><div class="section-head"><h2>' + label + '</h2></div><div class="sk-row">';
    for (var i = 0; i < 5; i++) {
      s += '<div class="sk-card"><div class="sk sk-poster"></div><div class="sk sk-line"></div><div class="sk sk-line short"></div></div>';
    }
    return s + "</div></section>";
  }

  function heroMarkup() {
    if (!S.banners.length) return "";
    var slides = S.banners.map(function (b, i) {
      var meta = [];
      if (b.rating) meta.push("<b>★ " + esc(b.rating) + "</b>");
      if (b.year) meta.push(esc(b.year));
      if (b.country) meta.push(esc(b.country));
      if (b.genre) meta.push(esc(String(b.genre).split(",")[0].trim()));
      return '<div class="hero-slide" style="background-image:' + cssUrl(b.bg || b.poster) + '">' +
        '<div class="hero-inner">' +
        '<div class="hero-badge"><i class="dot"></i><span>' + (i === 0 ? "SuperBox feature" : "Now streaming") + "</span></div>" +
        '<h1 class="hero-title">' + esc(b.t) + "</h1>" +
        '<div class="hero-meta">' + meta.map(function (x) { return "<span>" + x + "</span>"; }).join('<i class="sep"></i>') + "</div>" +
        (b.desc ? '<p class="hero-desc">' + esc(b.desc) + "</p>" : "") +
        '<div class="hero-actions">' +
        '<button class="btn-primary" data-hero-play="' + i + '">' + ICON.play + " Play now</button>" +
        '<button class="btn-ghost" data-hero-info="' + i + '">' + ICON.info + " Details</button>" +
        "</div></div></div>";
    }).join("");
    var dots = S.banners.map(function (_, i) { return '<i class="' + (i === 0 ? "on" : "") + '"></i>'; }).join("");
    return '<div class="hero"><div class="hero-track" id="heroTrack">' + slides + '</div><div class="hero-dots" id="heroDots">' + dots + "</div></div>";
  }

  function homeMarkup() {
    var chips = [
      ["Trending", "trending"],
      ["Movies", "movies"],
      ["Series", "series"],
      ["Anime", "anime"],
      ["Cinema", "cinema"],
      ["Live TV", "live"],
      ["18+", "adult"]
    ].map(function (c, i) {
      return '<button class="chip' + (i === 0 ? " on" : "") + '" data-go="' + c[1] + '">' + c[0] + "</button>";
    }).join("");

    var rowsHtml = S.homeRows.map(function (r, i) {
      var items = r.items.slice(0, 20);
      return '<section class="section" id="row-' + i + '" data-row-title="' + esc(r.title) + '">' +
        '<div class="section-head"><h2>' + esc(r.title) + ' <em>' + items.length + '</em></h2>' +
        '<button data-row="' + i + '">See all</button></div>' +
        '<div class="row-track">' + cards(items) + "</div></section>";
    }).join("");

    return heroMarkup() +
      '<div class="chips" id="homeChips">' + chips + "</div>" +
      (rowsHtml || '<div class="empty"><b>No catalogue rows</b>Pull to refresh from the Me tab.</div>') +
      '<div id="libHomeRows" class="lib-rows"></div>' +
      '<div class="footer"><div class="f-mark">SUPERBOX</div><p>Ad-free movies, series and anime. No account. No trackers.</p>' +
      '<button class="footer-link" data-lib-sources>All sources &amp; manga</button></div>';
  }

  function renderHome() {
    clearInterval(S.heroTimer);
    if (!S.home && S.homeRows.length === 0) view.innerHTML = skeletonHome();
    loadHome().then(function () {
      if (S.tab !== "home") return;
      if (!document.getElementById("libHomeRows") || !document.getElementById("heroTrack")) {
        view.innerHTML = homeMarkup();
        startHero();
      }
      paintLibRows("home");
      removeBoot();
    }).catch(function () {
      if (S.tab !== "home") return;
      view.innerHTML = errorView("Catalogue unavailable", "SuperBox could not reach the catalogue. Check the connection and try again.");
      paintLibRows("home");
      removeBoot();
    });
  }

  function paintLibRows(tab) {
    var host = document.getElementById(tab === "home" ? "libHomeRows" : "libTabRows");
    if (host && window.LIB && window.LIB.appendRows) {
      try { window.LIB.appendRows(host, tab); } catch (e) {}
    }
  }

  function startHero() {
    clearInterval(S.heroTimer);
    var track = document.getElementById("heroTrack");
    var dots = document.getElementById("heroDots");
    if (!track) return;
    var slides = $$(".hero-slide", track);
    if (slides.length < 2) return;
    var current = 0;
    function setDot(i) {
      if (!dots) return;
      $$("i", dots).forEach(function (d, k) { d.classList.toggle("on", k === i); });
    }
    track.addEventListener("scroll", function () {
      var i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
      if (i !== current) { current = i; setDot(i); }
    }, { passive: true });
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    S.heroTimer = setInterval(function () {
      if (document.hidden || !track.isConnected) return;
      current = (current + 1) % slides.length;
      track.scrollTo({ left: current * track.clientWidth, behavior: "smooth" });
      setDot(current);
    }, 6500);
  }

  function removeBoot() {
    if (!boot) return;
    setTimeout(function () {
      if (boot) {
        boot.classList.add("gone");
        setTimeout(function () { if (boot && boot.parentNode) boot.parentNode.removeChild(boot); }, 420);
      }
    }, 220);
  }

  function errorView(title, msg) {
    return '<div class="empty" style="padding-top:90px"><b>' + esc(title) + "</b>" + esc(msg) +
      '<div style="margin-top:18px"><button class="btn-primary" data-retry="1">Try again</button></div></div>';
  }

  // ---------------------------------------------------------------- library
  function isAnimeItem(it) {
    return /anime|animation|animated/i.test(String(it.genre || ""));
  }

  function buildTabData(tab) {
    var rows = S.homeRows || [];
    var cond = function () { return true; };
    if (tab === "movies") cond = function (it) { return it.stype === 1; };
    else if (tab === "series") cond = function (it) { return it.stype !== 1; };
    else if (tab === "anime") cond = function (it) { return isAnimeItem(it); };

    var selectedRows = rows;
    if (tab === "anime") {
      selectedRows = rows.filter(function (r) {
        return /anime|animation/i.test(r.title) || r.items.some(isAnimeItem);
      });
    }

    var cats = [];
    var all = [];
    selectedRows.forEach(function (r) {
      var its = dedupe(r.items.filter(cond));
      if (!its.length) return;
      all = all.concat(its);
      if (!cats.some(function (c) { return c.name === r.title; })) {
        cats.push({ name: r.title, items: its });
      }
    });
    all = dedupe(all);
    if (!all.length) {
      all = S.index.filter(cond);
      if (tab === "anime" && !all.length) all = S.index.filter(isAnimeItem);
      cats = [];
    }
    if (all.length) cats.unshift({ name: "All", items: all });
    return { cats: cats, all: all };
  }

  function libraryMarkup(tab, data) {
    var titles = { movies: "Movies", series: "Series", anime: "Anime" };
    var subs = {
      movies: "Blockbusters, Indian cinema and world films",
      series: "Bingeable dramas, sitcoms and short series",
      anime: "The best of Japanese and global animation"
    };
    var cats = data.cats.length ? data.cats : [{ name: "All", items: [] }];
    var active = S.catByTab[tab] || "All";
    if (!cats.some(function (c) { return c.name === active; })) active = "All";
    var cat = cats.filter(function (c) { return c.name === active; })[0] || cats[0];
    var chips = cats.map(function (c) {
      return '<button class="chip' + (c.name === active ? " on" : "") + '" data-cat="' + esc(c.name) + '">' + esc(c.name) + "</button>";
    }).join("");
    return '<div class="page-head"><div class="page-kicker">SuperBox library</div>' +
      '<h1 class="page-title">' + titles[tab] + "</h1>" +
      '<div class="page-sub" id="gridCount">' + cat.items.length + " titles · Ad-free</div>" +
      '<div class="lib-links"><button class="chip" data-lib-live>Live TV</button><button class="chip" data-lib-adult>18+</button><button class="chip" data-lib-sources>Sources</button></div></div>' +
      '<div class="chips" id="catChips">' + chips + "</div>" +
      '<div class="grid" id="gridWrap">' + (cat.items.length ? cards(cat.items) : "") + "</div>" +
      (!cat.items.length ? '<div class="empty"><b>Nothing here yet</b>Try another category.</div>' : "") +
      '<div id="libTabRows" class="lib-rows"></div>';
  }

  function renderLibrary(tab) {
    clearInterval(S.heroTimer);
    view.innerHTML = '<div class="page-head"><div class="sk" style="width:105px;height:10px;margin-bottom:10px"></div><div class="sk" style="width:190px;height:31px;border-radius:9px"></div></div>' +
      '<div class="chips"><span class="sk" style="width:62px;height:32px;border-radius:999px"></span><span class="sk" style="width:90px;height:32px;border-radius:999px"></span><span class="sk" style="width:76px;height:32px;border-radius:999px"></span></div>' +
      '<div class="grid">' + Array(9).join('<div class="sk sk-poster"></div>') + "</div>";
    paintLibRows(tab);
    loadHome().then(function () {
      if (S.tab !== tab) return;
      var data = buildTabData(tab);
      S.tabData[tab] = data;
      view.innerHTML = libraryMarkup(tab, data);
      paintLibRows(tab);
      removeBoot();
    }).catch(function () {
      if (S.tab !== tab) return;
      view.innerHTML = errorView("Library unavailable", "The catalogue could not be loaded.");
      paintLibRows(tab);
      removeBoot();
    });
  }

  // ---------------------------------------------------------------- me
  function qualityText(h) {
    if (h === 480) return "480p";
    if (h === 720) return "720p";
    if (h === 1080) return "1080p";
    return "Auto";
  }

  function renderMe() {
    clearInterval(S.heroTimer);
    var version = "1.3.0";
    try { if (window.SBAndroid && window.SBAndroid.version) version = window.SBAndroid.version(); } catch (e) {}
    view.innerHTML =
      '<div class="page-head" style="padding-top:14px"><div class="page-kicker">Your space</div><h1 class="page-title">Me</h1></div>' +
      '<div class="me-card"><div class="me-avatar">S</div><h2 class="me-name">SuperBox</h2>' +
      '<div class="me-sub">Your ad-free entertainment hub</div>' +
      '<div class="me-badges"><span>NO ADS</span><span>NO ACCOUNT</span><span>NO TRACKERS</span></div></div>' +
      '<div class="me-section"><h3>Playback</h3><div class="me-list">' +
      '<button class="me-row" data-setting="quality"><span class="ic">HD</span><span class="tx"><b>Default quality</b><span>Start streams on a smooth tier</span></span><span class="rt">' + qualityText(S.quality) + "</span></button>" +
      '<button class="me-row" data-setting="autoplay"><span class="ic">▶</span><span class="tx"><b>Autoplay next episode</b><span>Continue series without a tap</span></span><span class="switch ' + (S.autoplay ? "on" : "") + '"></span></button>' +
      "</div></div>" +
      '<div class="me-section"><h3>Catalogue</h3><div class="me-list">' +
      '<button class="me-row" data-setting="refresh"><span class="ic">↻</span><span class="tx"><b>Refresh catalogue</b><span>Fetch the latest SuperBox rows</span></span><span class="rt">Refresh</span></button>' +
      '<button class="me-row" data-setting="vpn"><span class="ic">?</span><span class="tx"><b>SuperBox Shield</b><span>Embedded VPN status and region</span></span><span class="rt" id="meVpnState">Checking?</span></button>' +
      '<button class="me-row" data-setting="sources"><span class="ic">∞</span><span class="tx"><b>Library sources</b><span>Metadata, archives and live TV</span></span><span class="rt">View</span></button>' +
      '<button class="me-row" data-setting="clear"><span class="ic">×</span><span class="tx"><b>Clear temporary data</b><span>Quality preference and cached UI state</span></span><span class="rt">Clear</span></button>' +
      '<button class="me-row" data-setting="about"><span class="ic">i</span><span class="tx"><b>About SuperBox</b><span>Version ' + esc(version) + " · Mobile</span></span><span class=\"rt\">Info</span></button>" +
      "</div></div>" +
      '<div class="about-note">SuperBox Mobile ' + esc(version) + "<br>Ad-free catalogue browser and player.<br>Built for touch.</div>";
    if (vpnState) paintVpnGate(vpnState);
    removeBoot();
  }

  /* ---------------------------------------------------------- Shield VPN */
  var vpnState = null;
  var vpnGateTimer = 0;
  var VPN_REGIONS = [
    ["auto", "Global"], ["us", "United States"], ["ca", "Canada"], ["uk", "United Kingdom"],
    ["au", "Australia"], ["in", "India"], ["de", "Germany"], ["jp", "Japan"]
  ];
  function vpnApi(path) {
    return fetch(path, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }
  function vpnOn(st) { return !!(st && st.ok); }
  function paintVpnGate(st) {
    var gate = document.getElementById("vpnGate");
    if (!gate) return;
    vpnState = st || vpnState;
    var on = vpnOn(st);
    gate.classList.toggle("hidden", on);
    gate.classList.toggle("on", on);
    gate.classList.toggle("err", !!st && st.state === "error");
    var title = document.getElementById("vpnTitle");
    var msg = document.getElementById("vpnMsg");
    if (title) title.textContent = on ? "Shield connected" :
      (st && st.state === "error" ? "Shield needs a retry" : "Connecting the Shield");
    if (msg) msg.textContent = on
      ? "Anonymous WARP tunnel is live. Every request in SuperBox rides it."
      : (st && st.state === "error"
        ? "The tunnel did not come up. Retry, or pick another regional profile."
        : "Establishing an anonymous WARP tunnel. Every catalogue, image and stream stays behind it.");
    var engine = document.getElementById("vpnEngine");
    if (engine) engine.textContent = (st && st.engine) || "usque · MASQUE";
    var rl = document.getElementById("vpnRegionLabel");
    if (rl) rl.textContent = (st && st.regionLabel) || "Global";
    var eg = document.getElementById("vpnEgress");
    if (eg) eg.textContent = (st && (st.egress || st.ip)) || "—";
    var wp = document.getElementById("vpnWarp");
    if (wp) wp.textContent = st && st.warp ? "ON" : ((st && st.state) || "OFF");
    var err = document.getElementById("vpnErr");
    if (err) err.textContent = (st && st.error) ? st.error : "";
    var me = document.getElementById("meVpnState");
    if (me) me.textContent = on
      ? ("Connected · " + (st.egress || st.regionLabel || "WARP"))
      : ((st && (st.state || "off")) + " · " + (st && st.error ? "retry" : "connecting"));
    var sel = document.getElementById("vpnRegion");
    if (sel && st && st.region && document.activeElement !== sel) {
      try { sel.value = st.region; } catch (e) {}
    }
  }
  function watchVpnGate() {
    clearTimeout(vpnGateTimer);
    vpnApi("/api/vpn/status").then(function (st) {
      paintVpnGate(st);
      vpnGateTimer = setTimeout(watchVpnGate, vpnOn(st) ? 8000 : 1600);
    }).catch(function () {
      var gate = document.getElementById("vpnGate");
      if (gate) gate.classList.remove("hidden");
      var title = document.getElementById("vpnTitle");
      if (title) title.textContent = "Starting the Shield";
      var msg = document.getElementById("vpnMsg");
      if (msg) msg.textContent = "Waiting for the local engine to answer. This usually takes a few seconds.";
      vpnGateTimer = setTimeout(watchVpnGate, 1400);
    });
  }
  function switchVpnRegion(region) {
    var msg = document.getElementById("vpnMsg");
    if (msg) msg.textContent = "Switching the Shield endpoint…";
    return vpnApi("/api/vpn/switch?region=" + enc(region || "auto")).then(function (st) {
      paintVpnGate(st);
      return st;
    });
  }
  function reconnectVpn(region) {
    var err = document.getElementById("vpnErr");
    if (err) err.textContent = "Restarting the tunnel…";
    return vpnApi("/api/vpn/reconnect?region=" + enc(region || "auto")).then(function (st) {
      paintVpnGate(st);
      return st;
    });
  }
  function startVpnGate() {
    var gate = document.getElementById("vpnGate");
    if (!gate) return;
    var sel = document.getElementById("vpnRegion");
    if (sel) sel.onchange = function () { switchVpnRegion(sel.value).catch(function () {}); };
    var retry = document.getElementById("vpnRetry");
    if (retry) retry.onclick = function () {
      retry.disabled = true;
      reconnectVpn((sel && sel.value) || "auto").catch(function () {}).then(function () {
        retry.disabled = false;
      });
    };
    watchVpnGate();
  }
  function openVpnSheet() {
    var st = vpnState || {};
    var on = vpnOn(st);
    var region = st.region || "auto";
    var html = '<div class="sheet-title">SuperBox Shield</div>' +
      '<div class="sheet-sub">Embedded WARP tunnel · usque / MASQUE</div>' +
      '<div style="padding:4px 20px 0"><div class="me-list">' +
      '<div class="me-row"><span class="ic">●</span><span class="tx"><b>Status</b><span id="vpnSheetState">' +
      esc(on ? "Connected" : ((st.state || "starting") + (st.error ? " · " + st.error : ""))) +
      '</span></span><span class="rt" style="color:' + (on ? "#41e88a" : "#ff8a8a") + '">' + (on ? "ON" : "OFF") + '</span></div>' +
      '<div class="me-row"><span class="ic">IP</span><span class="tx"><b>Egress</b><span id="vpnSheetIp">' +
      esc((st.egress || st.ip || "—") + (st.regionLabel ? " · " + st.regionLabel : "")) +
      '</span></span></div></div>' +
      '<div class="sheet-sub" style="padding:16px 0 8px">Preferred region</div>' +
      '<div class="chips" id="vpnSheetRegions" style="padding:0 0 8px">' +
      VPN_REGIONS.map(function (r) {
        return '<button class="chip' + (r[0] === region ? " on" : "") + '" data-vpn-region="' + r[0] + '">' + esc(r[1]) + "</button>";
      }).join("") + '</div>' +
      '<button class="btn-primary" id="vpnSheetRetry" style="width:100%;margin:10px 0 20px">Reconnect tunnel</button>' +
      '<div style="color:#777782;font-size:11.5px;line-height:1.6;padding-bottom:22px">Cloudflare WARP endpoints are anycast. The requested region is preferred, and the actual exit is shown above once connected. All catalogue, image and player traffic stays inside the tunnel.</div>' +
      '</div></div>';
    openSheet(html, function (root) {
      $$("[data-vpn-region]", root).forEach(function (b) {
        b.onclick = function () {
          var r = b.getAttribute("data-vpn-region");
          $$("[data-vpn-region]", root).forEach(function (x) { x.classList.toggle("on", x === b); });
          var stateEl = document.getElementById("vpnSheetState");
          if (stateEl) stateEl.textContent = "Switching to " + b.textContent;
          switchVpnRegion(r).then(function (next) {
            openSheetRefresh(next);
          }).catch(function () {
            if (stateEl) stateEl.textContent = "Switch failed. Try reconnect.";
          });
        };
      });
      var retry = document.getElementById("vpnSheetRetry");
      if (retry) retry.onclick = function () {
        retry.disabled = true;
        var stateEl = document.getElementById("vpnSheetState");
        if (stateEl) stateEl.textContent = "Restarting the tunnel…";
        reconnectVpn(region).then(function (next) {
          openSheetRefresh(next);
          retry.disabled = false;
        }).catch(function () {
          if (stateEl) stateEl.textContent = "Reconnect failed";
          retry.disabled = false;
        });
      };
    });
  }
  function openSheetRefresh(st) {
    var stateEl = document.getElementById("vpnSheetState");
    var ipEl = document.getElementById("vpnSheetIp");
    if (stateEl) stateEl.textContent = vpnOn(st) ? "Connected" : ((st && st.state) || "starting");
    if (ipEl) ipEl.textContent = ((st && (st.egress || st.ip)) || "—") + (st && st.regionLabel ? " · " + st.regionLabel : "");
  }

  // ---------------------------------------------------------------- detail
  function seasonsOf(s) {
    var raw = (s && s.__seasons) || [];
    var out = [];
    raw.forEach(function (x) {
      var se = num(x && x.se, 0);
      var max = num(x && x.maxEp, 0);
      if (max > 0) out.push({ se: se, maxEp: Math.min(max, 400) });
    });
    out.sort(function (a, b) { return a.se - b.se; });
    return out;
  }

  function isSeriesSubject(s, seasons) {
    var st = num(s && s.subjectType, 0);
    if (st === 1) return false;
    if (st === 2 || st === 3 || st === 7) return true;
    if (seasons && seasons.length && (seasons.length > 1 || seasons[0].maxEp > 1)) return true;
    return false;
  }

  function getDetailCache(item) {
    var key = item.id + "|" + item.dp;
    var hit = S.detailCache.get(key);
    if (hit && Date.now() - hit.at < 300000) return hit.data;
    return null;
  }

  async function fetchDetail(item) {
    var cached = getDetailCache(item);
    if (cached) return cached;
    var j = await api("detail?subjectId=" + enc(item.id) + "&detailPath=" + enc(item.dp) + "&se=0");
    var d = j && j.data;
    if (!d || !d.subject) throw new Error("detail unavailable");
    var s = d.subject;
    s.__seasons = (d.resource && d.resource.seasons) || [];
    var seasons = seasonsOf(s);
    var isSeries = isSeriesSubject(s, seasons);
    if (isSeries && !seasons.length) seasons = [{ se: 1, maxEp: 1 }];
    var data = { s: s, d: d, item: item, seasons: seasons, isSeries: isSeries };
    S.detailCache.set(item.id + "|" + item.dp, { at: Date.now(), data: data });
    return data;
  }

  function skeletonDetail() {
    return '<button class="detail-back" data-dback="1" aria-label="Back">' + ICON.back + "</button>" +
      '<div class="sk" style="height:290px;border-radius:0"></div>' +
      '<div class="detail-body"><div style="display:flex;gap:15px;margin-top:-105px">' +
      '<div class="sk" style="width:108px;aspect-ratio:2/3;border-radius:14px"></div>' +
      '<div style="flex:1;padding-top:70px"><div class="sk" style="height:11px;width:95px"></div><div class="sk" style="height:26px;width:80%;margin-top:10px"></div><div class="sk" style="height:11px;width:65%;margin-top:10px"></div></div>' +
      "</div>" +
      '<div class="sk" style="height:11px;width:100%;margin-top:24px"></div><div class="sk" style="height:11px;width:92%;margin-top:8px"></div>' +
      '<div class="sk" style="height:46px;border-radius:999px;margin-top:22px"></div>' +
      "</div>";
  }

  function metaChips(s, extra) {
    var out = [];
    if (num(s.imdbRatingValue, 0) > 0) out.push('<span class="meta-chip gold">★ ' + esc(num(s.imdbRatingValue, 0).toFixed(1)) + "</span>");
    var year = String(s.releaseDate || "").slice(0, 4);
    if (year) out.push('<span class="meta-chip">' + esc(year) + "</span>");
    if (s.countryName) out.push('<span class="meta-chip">' + esc(s.countryName) + "</span>");
    String(s.genre || "").split(",").filter(Boolean).slice(0, 3).forEach(function (g) {
      out.push('<span class="meta-chip">' + esc(g.trim()) + "</span>");
    });
    (extra || []).forEach(function (x) { out.push('<span class="meta-chip">' + esc(x) + "</span>"); });
    return out.join("");
  }

  function epGridMarkup(data, se) {
    var sn = data.seasons.filter(function (x) { return x.se === se; })[0] || data.seasons[0];
    if (!sn) return "";
    var html = "";
    for (var i = 1; i <= sn.maxEp; i++) {
      var on = S.lastPlayed && S.lastPlayed.id === data.item.id && S.lastPlayed.se === se && S.lastPlayed.ep === i;
      html += '<button class="' + (on ? "on" : "") + '" data-season="' + se + '" data-ep="' + i + '">' + i + "</button>";
    }
    return html;
  }

  function detailMarkup(data) {
    var s = data.s;
    var item = data.item;
    var poster = mediaUrl(s.cover) || item.poster;
    var backdrop = mediaUrl(s.stills) || item.bg || poster;
    var title = s.title || item.t || "SuperBox";
    var selected = data.seasons.filter(function (x) { return x.se === S.detailSeason; })[0] || data.seasons[0];
    var se = selected ? selected.se : 1;
    var trailer = s.trailer && s.trailer.videoAddress && s.trailer.videoAddress.url;
    var desc = String(s.description || item.desc || "");
    var staff = (s.staffList || []).filter(function (p) { return p && (p.name || p.staffName || p.title); });
    var playLabel = data.isSeries ? "Play S" + se + "E1" : "Play now";

    var seasonTabs = "";
    if (data.isSeries && data.seasons.length > 1) {
      seasonTabs = '<div class="season-tabs">' + data.seasons.map(function (sn) {
        return '<button class="' + (sn.se === se ? "on" : "") + '" data-season="' + sn.se + '">Season ' + sn.se + "</button>";
      }).join("") + "</div>";
    }
    var eps = data.isSeries ? '<div class="detail-section" id="dEpSec"><h3>Episodes <em>' +
      data.seasons.reduce(function (a, x) { return a + x.maxEp; }, 0) + "</em></h3>" + seasonTabs +
      '<div class="ep-grid" id="dEpGrid">' + epGridMarkup(data, se) + "</div></div>" : "";

    var cast = staff.length ? '<div class="detail-section"><h3>Cast</h3><div class="cast-row">' +
      staff.slice(0, 20).map(function (p) {
        var av = mediaUrl(p.avatarUrl) || mediaUrl(p.avatar) || mediaUrl(p.image);
        var nm = p.name || p.staffName || p.title || "";
        var role = p.character || p.role || p.characterName || "";
        return '<div class="person"><div class="av">' + (av ? '<img src="' + imgUrl(av) + '" alt="' + esc(nm) + '" loading="lazy" onerror="SBIMG(this)">' : esc(initials(nm))) + "</div>" +
          '<div class="nm">' + esc(nm) + "</div>" + (role ? '<div class="role">' + esc(role) + "</div>" : "") + "</div>";
      }).join("") + "</div></div>" : "";

    return '<button class="detail-back" data-dback="1" aria-label="Back">' + ICON.back + "</button>" +
      '<div class="detail-hero" style="background-image:' + cssUrl(backdrop) + '"></div>' +
      '<div class="detail-body">' +
      '<div class="detail-top"><div class="detail-poster"><span class="ph">' + esc(initials(title)) + "</span>" +
      (poster ? '<img src="' + imgUrl(poster) + '" alt="' + esc(title) + '" onerror="SBIMG(this)">' : "") +
      "</div><div class=\"detail-head\"><div class=\"detail-type\">" + (data.isSeries ? "Series" : "Movie") + "</div>" +
      '<h1 class="detail-title">' + esc(title) + "</h1>" +
      '<div class="detail-meta">' + metaChips(s, [data.isSeries ? "Ad-free stream" : "Ad-free"]) + "</div>" +
      "</div></div>" +
      '<div class="detail-actions"><button class="btn-primary" data-dplay="1">' + ICON.play + " " + esc(playLabel) + "</button>" +
      (trailer ? '<button class="btn-ghost" data-dtrailer="1">Trailer</button>' : "") +
      "</div>" +
      (desc ? '<p class="detail-desc" id="dDesc">' + esc(desc) + "</p>" + (desc.length > 280 ? '<button class="desc-more" data-ddesc="1">Read more</button>' : "") : "") +
      eps + cast +
      '<div class="detail-section" id="dRecSec"><h3>More like this</h3><div class="row-track" id="dRec"><div class="sk-card"><div class="sk sk-poster"></div><div class="sk sk-line"></div></div><div class="sk-card"><div class="sk sk-poster"></div><div class="sk sk-line"></div></div><div class="sk-card"><div class="sk sk-poster"></div><div class="sk sk-line"></div></div></div></div>' +
      "</div>";
  }

  async function openDetail(item, opts) {
    if (!item) return;
    var fresh = getItem(item.id) || item;
    S.detailOpen = true;
    S.detailToken++;
    var token = S.detailToken;
    S.detailData = null;
    S.detailSeason = null;
    closeSheet();
    detail.classList.remove("hidden");
    detail.setAttribute("aria-hidden", "false");
    detail.scrollTop = 0;
    detail.innerHTML = skeletonDetail();
    lockBody();
    try {
      var data = await fetchDetail(fresh);
      if (!S.detailOpen || S.detailToken !== token) return;
      S.detailData = data;
      if (S.detailSeason == null) S.detailSeason = data.seasons.length ? data.seasons[0].se : 1;
      detail.innerHTML = detailMarkup(data);
      detail.scrollTop = 0;
      loadRecommendations(data, token);
      if (opts && opts.autoplay) {
        startPlayback(data.s, data.item, data.seasons.length ? data.seasons[0].se : 0, data.isSeries ? 1 : 0, {});
      }
    } catch (e) {
      if (!S.detailOpen || S.detailToken !== token) return;
      detail.innerHTML = '<button class="detail-back" data-dback="1" aria-label="Back">' + ICON.back + "</button>" +
        '<div class="empty" style="padding-top:120px"><b>Title unavailable</b>This title could not be loaded right now.</div>';
    }
  }

  function closeDetail(silent) {
    if (!S.detailOpen) return;
    S.detailOpen = false;
    S.detailToken++;
    S.detailData = null;
    detail.classList.add("hidden");
    detail.setAttribute("aria-hidden", "true");
    detail.innerHTML = "";
    lockBody();
    if (!silent) window.scrollTo(0, 0);
  }

  async function loadRecommendations(data, token) {
    try {
      var j = await api("rec?subjectId=" + enc(data.s.subjectId) + "&page=1&perPage=18");
      if (!S.detailOpen || S.detailToken !== token) return;
      var box = document.getElementById("dRec");
      if (!box) return;
      var items = (((j && j.data && (j.data.items || j.data.subjectList)) || [])).map(normSubject).filter(function (x) {
        return x && x.id !== data.item.id;
      });
      mergeIndex(items);
      box.innerHTML = items.length ? cards(items) : '<div class="empty">No suggestions for this title yet.</div>';
    } catch (e) {
      var box2 = document.getElementById("dRec");
      if (box2) box2.innerHTML = '<div class="empty">No suggestions for this title yet.</div>';
    }
  }

  // ---------------------------------------------------------------- player
  function qualityLabel(q) {
    if (!q) return "Auto";
    if (q.height) return q.height + "p";
    if (/dash/i.test(q.format || "")) return "DASH";
    if (/hls/i.test(q.format || "")) return "HLS";
    return "Auto";
  }

  function streamFormat(q) {
    var f = String((q && q.format) || "").toLowerCase();
    var u = String((q && q.url) || "");
    if (f.indexOf("dash") >= 0 || /\.mpd(?:[?#]|$)/i.test(u)) return "dash";
    if (f.indexOf("hls") >= 0 || f.indexOf("m3u8") >= 0 || /\.m3u8(?:[?#]|$)/i.test(u)) return "hls";
    return "mp4";
  }

  function loadScriptOnce(src) {
    if (scriptPromises[src]) return scriptPromises[src];
    scriptPromises[src] = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { scriptPromises[src] = null; reject(new Error("engine " + src)); };
      document.head.appendChild(s);
    });
    return scriptPromises[src];
  }

  function ensureHls() {
    if (window.Hls && window.Hls.isSupported && window.Hls.isSupported()) return Promise.resolve();
    if (window.Hls) return Promise.resolve();
    return loadScriptOnce("/hls.min.js");
  }

  function ensureDash() {
    if (window.dashjs) return Promise.resolve();
    return loadScriptOnce("/dash.all.min.js");
  }

  function destroyEngines() {
    if (hlsEngine) {
      try { hlsEngine.destroy(); } catch (e) {}
      hlsEngine = null;
    }
    if (dashEngine) {
      try { dashEngine.reset(); } catch (e) {}
      dashEngine = null;
    }
  }

  function engineUrl(format, q, ref) {
    var path = format === "hls" ? "/hls" : (format === "dash" ? "/dash" : "/stream");
    return withToken(path + "?url=" + enc(q.url) + "&ref=" + enc(ref || ""));
  }

  function tryNextQuality(reason) {
    var pb = S.playback;
    if (!pb) return false;
    var cur = pb.quality;
    if (cur && !pb.tried[cur.id]) pb.tried[cur.id] = 1;
    var next = (pb.qualities || []).filter(function (q) {
      return q && q.id !== (cur && cur.id) && !pb.tried[q.id];
    })[0];
    if (!next && pb.failCount === 0) {
      next = (pb.qualities || []).filter(function (q) { return q && q.id !== (cur && cur.id); })[0];
    }
    if (!next) return false;
    pb.failCount = (pb.failCount || 0) + 1;
    if (pb.failCount > 6) return false;
    pb.quality = next;
    toast(reason || ("Trying " + qualityLabel(next)));
    updatePlayerLabels();
    loadStream(num(video.currentTime, 0), true);
    return true;
  }

  function qualityList(d) {
    var arr = [];
    function push(x, fallbackFormat) {
      if (!x) return;
      if (typeof x === "string") {
        arr.push({
          id: x, url: x, height: 0,
          format: /\.m3u8/i.test(x) ? "HLS" : (/\.mpd/i.test(x) ? "DASH" : (fallbackFormat || "MP4")),
          size: 0, duration: 0
        });
        return;
      }
      if (!x.url || x.vipLocked) return;
      var format = String(x.format || fallbackFormat || (/\.mpd/i.test(x.url) ? "DASH" : (/\.m3u8/i.test(x.url) ? "HLS" : "MP4"))).toUpperCase();
      var raw = String(x.resolutions || x.resolution || x.height || "").split(",")[0];
      var h = parseInt(raw, 10);
      arr.push({
        id: String(x.id || x.streamId || x.url),
        url: /^\/\//.test(x.url) ? "https:" + x.url : String(x.url),
        height: isFinite(h) ? h : 0,
        format: format,
        size: num(x.size, 0),
        duration: num(x.duration, 0),
        codec: x.codecName || ""
      });
    }
    (d.streams || []).forEach(function (x) { push(x, "MP4"); });
    (d.hls || []).forEach(function (x) { push(x, "HLS"); });
    (d.dash || []).forEach(function (x) { push(x, "DASH"); });
    var seen = {};
    arr = arr.filter(function (q) {
      if (!q.url || seen[q.url]) return false;
      seen[q.url] = 1;
      return true;
    });
    arr.sort(function (a, b) { return (b.height || 0) - (a.height || 0); });
    return arr;
  }

  function chooseQuality(list, want) {
    var asc = (list || []).slice().sort(function (a, b) { return (a.height || 0) - (b.height || 0); });
    if (!asc.length) return null;
    var exact = null, lower = null, smooth = null;
    asc.forEach(function (q) {
      var h = num(q.height, 0);
      if (want && h === num(want, 0)) exact = q;
      if (want && h && h <= num(want, 0)) lower = q;
      if (!smooth && h >= 360 && h <= 720) smooth = q;
    });
    return exact || lower || smooth || asc[0];
  }

  function audioTracksOf(s) {
    var sid = String(s.subjectId);
    var dp = s.detailPath;
    var arr = (s.dubs || []).filter(function (a) { return a && a.subjectId; }).map(function (a) {
      return {
        subjectId: String(a.subjectId),
        detailPath: a.detailPath || dp,
        lanName: a.lanName || a.language || "Audio",
        lanCode: a.lanCode || "",
        original: !!a.original,
        type: num(a.type, 0),
        current: String(a.subjectId) === sid
      };
    });
    var audioOnly = arr.filter(function (a) { return a.type !== 1; });
    if (audioOnly.length) arr = audioOnly;
    if (!arr.length || !arr.some(function (a) { return String(a.subjectId) === sid; })) {
      arr.unshift({
        subjectId: sid, detailPath: dp, lanName: "Original Audio",
        lanCode: "", original: true, type: 0, current: true
      });
    }
    arr.forEach(function (a) { a.current = String(a.subjectId) === sid; });
    return arr;
  }

  function audioShort(a) {
    if (!a) return "Audio";
    var n = String(a.lanName || "").replace(/\s*(dub|audio|sub)\s*/gi, " ").replace(/\s+/g, " ").trim();
    if (!n) n = "Original";
    return n;
  }

  function qualityWant() {
    var want = num(S.quality, 0);
    if (want > 720) want = 0;
    return want;
  }

  function playerSub(pb) {
    if (!pb) return "";
    var parts = [];
    if (pb.isSeries) parts.push("S" + pb.se + " · E" + pb.ep);
    if (pb.quality) parts.push(qualityLabel(pb.quality));
    if (pb.trailer) parts.push("Trailer");
    return parts.join(" · ");
  }

  function updatePlayerLabels() {
    var pb = S.playback;
    if (!pb) return;
    pTitle.textContent = pb.title || "SuperBox";
    pSub.textContent = playerSub(pb);
    pQualityLabel.textContent = pb.quality ? qualityLabel(pb.quality) : "Auto";
    pAudioLabel.textContent = audioShort(pb.audio);
    pSpeedLabel.textContent = S.speed + "x";
    pEps.classList.toggle("hidden", !pb.isSeries);
  }

  function showSpinner(on) {
    if (!pSpinner) return;
    pSpinner.classList.toggle("hidden", !on);
    pPlay.style.opacity = on ? "0" : "1";
    pPlay.style.pointerEvents = on ? "none" : "auto";
  }

  function updatePlayIcon() {
    if (!pPlayIcon) return;
    var playing = video && !video.paused && !video.ended;
    pPlayIcon.innerHTML = playing
      ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z"></path>'
      : '<path d="M8 5.5v13l10-6.5-10-6.5Z"></path>';
  }

  function showControls() {
    if (!pUi) return;
    pUi.classList.remove("hide");
    clearTimeout(S.controlsTimer);
    if (video && !video.paused) {
      S.controlsTimer = setTimeout(hideControls, 3600);
    }
  }

  function hideControls() {
    if (!pUi) return;
    if (video && video.paused) return;
    pUi.classList.add("hide");
    clearTimeout(S.controlsTimer);
  }

  function toggleControls() {
    if (!pUi) return;
    if (pUi.classList.contains("hide")) showControls();
    else if (video && !video.paused) hideControls();
    else showControls();
  }

  function showGesture(text) {
    if (!pGesture) return;
    pGesture.textContent = text;
    pGesture.classList.add("show");
    clearTimeout(pGesture._t);
    pGesture._t = setTimeout(function () { pGesture.classList.remove("show"); }, 650);
  }

  function tryPlay() {
    if (!video) return;
    var p = video.play();
    if (p && p.catch) {
      p.catch(function () {
        showSpinner(false);
        updatePlayIcon();
        showControls();
      });
    }
  }

  function loadStream(at, wantPlay) {
    var pb = S.playback;
    if (!pb || !pb.quality) {
      showPlayerError("No playable stream was returned for this title.");
      return;
    }
    var q = pb.quality;
    var ref = pb.waRef || (pb.subject ? detailUrl((pb.audio && pb.audio.detailPath) || pb.subject.detailPath) : "");
    var format = streamFormat(q);
    var src = engineUrl(format, q, ref);
    pb.streamSrc = src;
    pb.format = format;
    pb.pendingSeek = num(at, 0);
    pb.wantPlay = wantPlay !== false;
    pb.failCount = pb.failCount || 0;
    pb._mediaFix = 0;
    pb._netFix = 0;
    pb._dashFix = 0;
    hidePlayerError();
    showSpinner(true);
    updatePlayIcon();
    updatePlayerLabels();
    destroyEngines();
    /* A new load supersedes every older watchdog. */
    clearTimeout(pb._watch);
    var loadGen = (pb._loadGen = (pb._loadGen || 0) + 1);
    var watchedAt = Date.now();
    var watch = function () {
      if (S.playback !== pb || pb._loadGen !== loadGen) return;
      if (video.readyState >= 2 || (!video.paused && video.currentTime > 0.2)) { pb._watch = null; return; }
      var idle = Date.now() - watchedAt;
      if (idle >= 45000 || (idle >= 18000 && video.networkState !== 2)) { failed("This stream is not responding — trying another"); return; }
      pb._watch = setTimeout(watch, 3000);
    };
    pb._watch = setTimeout(watch, 6000);

    function nativePlay() {
      try {
        /* Without this handler a dead direct MP4 / native-HLS URL left the
           spinner up forever: the <video> fired an error and nobody listened. */
        video.onerror = function () { failed("This stream failed — trying another"); };
        video.src = src;
        video.load();
      } catch (e) {
        showPlayerError("The player could not open this stream.");
      }
    }

    function failed(msg) {
      if (S.playback !== pb) return;
      clearTimeout(pb._watch);
      pb._watch = null;
      if (!tryNextQuality(msg || "This source failed — trying another")) {
        /* Nothing in the ladder worked. Before surfacing a dead end, hand the
           title to the backup stream (the local twin of the same file), then
           to the source's clean player, then to the source page. */
        if (pb.fallback && pb.fallback !== pb.quality.url) {
          var fb = pb.fallback;
          pb.fallback = "";
          toast("Trying a backup stream…");
          playDirect(fb, pb.title, {
            hls: /\.m3u8(?:[?#]|$)/i.test(fb),
            ref: pb.waRef || pb.page || "",
            embed: pb.embed || "",
            page: pb.page || "",
            poster: pb.poster || ""
          });
          return;
        }
        if (pb.embed) { toast("Opening the source player…"); openWeb(pb.embed, pb.title); return; }
        if (pb.page) { toast("Opening the source page…"); openWeb(pb.page, pb.title); return; }
        showPlayerError("This stream could not be played. Try another quality or episode.");
      }
    }

    try {
      video.onerror = null;
      video.pause();
      video.removeAttribute("src");
      video.load();
    } catch (e) {}

    if (format === "mp4") { nativePlay(); return; }

    if (format === "hls") {
      var nativeHls = video.canPlayType("application/vnd.apple.mpegurl");
      if (!(window.Hls && window.Hls.isSupported()) && (nativeHls === "probably" || nativeHls === "maybe")) {
        nativePlay();
        return;
      }
      ensureHls().then(function () {
        if (S.playback !== pb) return;
        if (!window.Hls || !window.Hls.isSupported()) { nativePlay(); return; }
        try {
          hlsEngine = new window.Hls({
            debug: false,
            enableWorker: true,
            lowLatencyMode: false,
            backBufferLength: 60,
            maxBufferLength: 40,
            maxMaxBufferLength: 120,
            manifestLoadingTimeOut: 20000,
            manifestLoadingMaxRetry: 4,
            levelLoadingMaxRetry: 4,
            fragLoadingMaxRetry: 6,
            startLevel: -1,
            capLevelToPlayerSize: true,
            testBandwidth: true
          });
          hlsEngine.on(window.Hls.Events.MANIFEST_PARSED, function () {
            if (S.playback !== pb) return;
            showSpinner(false);
            if (pb.wantPlay) tryPlay();
          });
          hlsEngine.on(window.Hls.Events.ERROR, function (evt, data) {
            if (S.playback !== pb || !data || !data.fatal) return;
            var type = String(data.type || "");
            if (type.indexOf("media") >= 0 && !pb._mediaFix) {
              pb._mediaFix = 1;
              try { hlsEngine.recoverMediaError(); return; } catch (e) {}
            }
            if (type.indexOf("network") >= 0 && !pb._netFix) {
              pb._netFix = 1;
              try { hlsEngine.startLoad(); return; } catch (e) {}
            }
            failed("This stream stopped responding — trying another");
          });
          hlsEngine.attachMedia(video);
          hlsEngine.loadSource(src);
        } catch (e) {
          failed("The HLS engine could not start");
        }
      }).catch(function () {
        if (nativeHls === "probably" || nativeHls === "maybe") nativePlay();
        else failed("The HLS engine could not load");
      });
      return;
    }

    ensureDash().then(function () {
      if (S.playback !== pb) return;
      if (!window.dashjs) { failed("The DASH engine could not load"); return; }
      try {
        dashEngine = window.dashjs.MediaPlayer().create();
        dashEngine.updateSettings({
          streaming: {
            abr: { initialBitrate: { audio: -1, video: -1 }, autoSwitchBitrate: { audio: true, video: true } },
            buffer: { fastSwitchEnabled: true, stableBufferTime: 20, bufferTimeAtTopQuality: 30 },
            delay: { liveDelay: 8 }
          }
        });
        dashEngine.on("error", function () {
          if (S.playback !== pb) return;
          if (!pb._dashFix) {
            pb._dashFix = 1;
            try { dashEngine.reset(); dashEngine.initialize(video, src, pb.wantPlay); return; } catch (e) {}
          }
          failed("This DASH stream failed — trying another");
        });
        dashEngine.initialize(video, src, pb.wantPlay);
      } catch (e) {
        failed("The DASH engine could not start");
      }
    }).catch(function () {
      failed("The DASH engine could not load");
    });
  }

  function showPlayerError(msg) {
    if (S.playback) { clearTimeout(S.playback._watch); S.playback._watch = null; }
    pErrorText.textContent = msg || "This stream could not be started.";
    pError.classList.remove("hidden");
    pUi.classList.add("hide");
    clearTimeout(S.controlsTimer);
    showSpinner(false);
  }

  function hidePlayerError() {
    if (pError) pError.classList.add("hidden");
  }

  function openPlayer(pb) {
    S.playback = pb;
    S.playerOpen = true;
    clearTimeout(S.autoNextTimer);
    pError.classList.add("hidden");
    pUi.classList.remove("hide");
    player.classList.remove("hidden");
    player.setAttribute("aria-hidden", "false");
    video.poster = pb.poster || "";
    updatePlayerLabels();
    updatePlayIcon();
    showSpinner(true);
    lockBody();
    try {
      if (window.SBAndroid) {
        if (window.SBAndroid.setLandscape) window.SBAndroid.setLandscape(true);
        if (window.SBAndroid.setImmersive) window.SBAndroid.setImmersive(true);
        if (window.SBAndroid.keepScreenOn) window.SBAndroid.keepScreenOn(true);
      }
    } catch (e) {}
    showControls();
    if (pb.quality) loadStream(0, true);
  }

  async function startPlayback(s, item, se, ep, opts) {
    opts = opts || {};
    var seasons = seasonsOf(s);
    var isSeries = isSeriesSubject(s, seasons);
    if (isSeries && !seasons.length) seasons = [{ se: 1, maxEp: 1 }];
    if (isSeries) {
      if (!se && seasons.length) se = seasons[0].se;
      if (!ep) ep = 1;
    } else {
      se = 0;
      ep = 0;
    }
    var tracks = audioTracksOf(s);
    var current = tracks.filter(function (a) { return a.current; })[0] || tracks[0];
    var title = s.title || (item && item.t) || "SuperBox";
    var pb = {
      subject: s,
      item: item || getItem(String(s.subjectId)),
      title: title,
      se: se,
      ep: ep,
      seasons: seasons,
      isSeries: isSeries,
      audioTracks: tracks,
      audio: current,
      qualities: [],
      quality: null,
      tried: {},
      failCount: 0,
      trailer: false,
      poster: mediaUrl(s.stills) || (item && item.bg) || (item && item.poster) || mediaUrl(s.cover),
      restart: function () { startPlayback(s, item, se, ep, opts); }
    };
    openPlayer(pb);
    var sid = String(s.subjectId);
    var dp = s.detailPath;
    try {
      var j = await api("play?subjectId=" + enc(sid) + "&detailPath=" + enc(dp) + "&se=" + se + "&ep=" + ep);
      if (S.playback !== pb) return;
      var d = (j && j.data) || {};
      var qs = qualityList(d);
      if (!qs.length && isSeries && ep === 1 && !opts.noFallback) {
        var sn = seasons.filter(function (x) { return x.se === se; })[0];
        if (sn && sn.maxEp >= 2) {
          toast("Episode 1 is unavailable — starting episode 2");
          return startPlayback(s, item, se, 2, { noFallback: true });
        }
      }
      if (!qs.length) {
        showPlayerError("This title has no playable stream right now.");
        return;
      }
      pb.qualities = qs;
      pb.quality = chooseQuality(qs, opts.height || qualityWant());
      pb.tried = {};
      pb.failCount = 0;
      S.lastPlayed = { id: String(s.subjectId), se: se, ep: ep };
      updatePlayerLabels();
      refreshDetailEpisodes();
      loadStream(opts.resumeAt || 0, true);
    } catch (e) {
      if (S.playback !== pb) return;
      showPlayerError("Could not connect to the SuperBox stream.");
    }
  }

  function closePlayer() {
    if (!S.playerOpen) return;
    S.playerOpen = false;
    clearTimeout(S.autoNextTimer);
    clearTimeout(S.controlsTimer);
    if (S.playback) { clearTimeout(S.playback._watch); S.playback._watch = null; }
    destroyEngines();
    try {
      video.pause();
      video.removeAttribute("src");
      video.load();
    } catch (e) {}
    player.classList.add("hidden");
    player.setAttribute("aria-hidden", "true");
    pError.classList.add("hidden");
    S.playback = null;
    lockBody();
    try {
      if (window.SBAndroid) {
        if (window.SBAndroid.setLandscape) window.SBAndroid.setLandscape(false);
        if (window.SBAndroid.setImmersive) window.SBAndroid.setImmersive(false);
        if (window.SBAndroid.keepScreenOn) window.SBAndroid.keepScreenOn(false);
      }
    } catch (e) {}
  }

  /* Native/engine playback for a stream that is already a real media URL
     (direct MP4 / HLS / DASH). The SuperBox player surface and gestures are
     reused, so touch controls, speed, rotate and seek behave identically. */
  function playDirect(url, title, opts) {
    opts = opts || {};
    if (!url) { toast("No playable stream was returned"); return; }
    var fmt = opts.format || (/\.mpd(?:[?#]|$)/i.test(url) ? "dash" : (/\.m3u8(?:[?#]|$)/i.test(url) ? "hls" : "mp4"));
    var q = { id: "wa", url: url, format: fmt, height: num(opts.height, 0) };
    var pb = {
      subject: { detailPath: "" },
      item: {},
      title: title || "SuperBox",
      se: 0, ep: 0, seasons: [], isSeries: false,
      audioTracks: [], audio: null,
      qualities: [q], quality: q,
      tried: {}, failCount: 0, trailer: false,
      poster: opts.poster || "",
      waRef: opts.ref || "",
      fallback: opts.fallback || "",
      embed: opts.embed || "",
      page: opts.page || "",
      restart: function () { closePlayer(); setTimeout(function () { playDirect(url, title, opts); }, 60); }
    };
    openPlayer(pb);
  }

  function openWeb(url, title) {
    if (!url) return;
    try {
      if (window.SBAndroid && window.SBAndroid.openWeb) window.SBAndroid.openWeb(url, title || "SuperBox");
      else window.open(url, "_blank");
    } catch (e) {
      toast("Could not open this player");
    }
  }

  /* Ordered provider shells: the native overlay rotates past dead ones. */
  function openLadder(urls, title) {
    var list = (urls || []).filter(function (u) { return !!u; });
    if (!list.length) return;
    if (list.length === 1) { openWeb(list[0], title); return; }
    try {
      if (window.SBAndroid && window.SBAndroid.openLadder) {
        window.SBAndroid.openLadder(JSON.stringify(list), title || "SuperBox");
      } else {
        openWeb(list[0], title);
      }
    } catch (e) {
      openWeb(list[0], title);
    }
  }

  function refreshDetailEpisodes() {
    if (!S.detailOpen || !S.detailData) return;
    var grid = document.getElementById("dEpGrid");
    if (!grid) return;
    var se = S.detailSeason;
    var sn = S.detailData.seasons.filter(function (x) { return x.se === se; })[0] || S.detailData.seasons[0];
    if (sn) grid.innerHTML = epGridMarkup(S.detailData, sn.se);
  }

  function switchQuality(q) {
    var pb = S.playback;
    if (!pb || !q) return;
    closeSheet();
    if (pb.quality && pb.quality.id === q.id) return;
    var at = num(video.currentTime, 0);
    pb.quality = q;
    pb.tried = {};
    pb.failCount = 0;
    S.quality = num(q.height, 0);
    prefSet("sb.quality", S.quality);
    updatePlayerLabels();
    toast("Quality: " + qualityLabel(q));
    loadStream(at, true);
  }

  async function switchAudio(a) {
    var pb = S.playback;
    if (!pb || !a) return;
    if (pb.audio && pb.audio.subjectId === a.subjectId) { closeSheet(); return; }
    var at = num(video.currentTime, 0);
    closeSheet();
    showSpinner(true);
    try {
      var j = await api("play?subjectId=" + enc(a.subjectId) + "&detailPath=" + enc(a.detailPath || pb.subject.detailPath) + "&se=" + pb.se + "&ep=" + pb.ep);
      if (S.playback !== pb) return;
      var qs = qualityList((j && j.data) || {});
      if (!qs.length) throw new Error("no streams");
      pb.qualities = qs;
      pb.quality = chooseQuality(qs, pb.quality ? pb.quality.height : qualityWant());
      pb.audio = a;
      pb.audioTracks.forEach(function (x) { x.current = x.subjectId === a.subjectId; });
      pb.tried = {};
      pb.failCount = 0;
      updatePlayerLabels();
      toast("Audio: " + audioShort(a));
      loadStream(at, true);
    } catch (e) {
      toast("That audio track is unavailable");
      showSpinner(false);
    }
  }

  async function switchEpisode(se, ep) {
    var pb = S.playback;
    if (!pb || !pb.isSeries) return;
    closeSheet();
    showSpinner(true);
    try {
      var a = pb.audio || {};
      var sid = a.subjectId || pb.subject.subjectId;
      var dp = a.detailPath || pb.subject.detailPath;
      var j = await api("play?subjectId=" + enc(sid) + "&detailPath=" + enc(dp) + "&se=" + se + "&ep=" + ep);
      if (S.playback !== pb) return;
      var qs = qualityList((j && j.data) || {});
      if (!qs.length) throw new Error("no streams");
      pb.se = se;
      pb.ep = ep;
      pb.qualities = qs;
      pb.quality = chooseQuality(qs, pb.quality ? pb.quality.height : qualityWant());
      pb.tried = {};
      pb.failCount = 0;
      S.lastPlayed = { id: String(pb.subject.subjectId), se: se, ep: ep };
      updatePlayerLabels();
      refreshDetailEpisodes();
      toast("S" + se + " · E" + ep);
      loadStream(0, true);
    } catch (e) {
      toast("That episode is unavailable");
      showSpinner(false);
      showPlayerError("This episode has no playable stream right now.");
    }
  }

  function nextEpisode() {
    var pb = S.playback;
    if (!pb || !pb.isSeries) return false;
    var sn = pb.seasons.filter(function (x) { return x.se === pb.se; })[0];
    if (!sn) return false;
    var se = pb.se;
    var ep = pb.ep + 1;
    if (ep > sn.maxEp) {
      var idx = pb.seasons.indexOf(sn);
      if (idx < 0 || idx + 1 >= pb.seasons.length) return false;
      se = pb.seasons[idx + 1].se;
      ep = 1;
    }
    switchEpisode(se, ep);
    return true;
  }

  function startTrailer(s, item) {
    var tr = s.trailer && s.trailer.videoAddress && s.trailer.videoAddress.url;
    if (!tr) { toast("No trailer available"); return; }
    var q = { id: "trailer", url: tr, height: 0, format: "MP4", size: 0, duration: 0 };
    var audio = { subjectId: String(s.subjectId), detailPath: s.detailPath, lanName: "Original Audio", original: true, current: true };
    var pb = {
      subject: s, item: item, title: (s.title || item.t) + " · Trailer",
      se: 0, ep: 0, seasons: [], isSeries: false,
      audioTracks: [audio], audio: audio,
      qualities: [q], quality: q, tried: {}, failCount: 0,
      trailer: true, poster: mediaUrl(s.stills) || item.bg || item.poster,
      restart: function () { startTrailer(s, item); }
    };
    openPlayer(pb);
    loadStream(0, true);
  }

  // ---------------------------------------------------------------- sheets
  function openSheet(html, ready) {
    clearTimeout(S.sheetHideTimer);
    sheetContent.innerHTML = html;
    sheet.classList.remove("hidden");
    sheet.setAttribute("aria-hidden", "false");
    S.sheetOpen = true;
    lockBody();
    if (ready) ready(sheetContent);
    requestAnimationFrame(function () { sheet.classList.add("open"); });
  }

  function closeSheet() {
    if (!S.sheetOpen) return;
    S.sheetOpen = false;
    sheet.classList.remove("open");
    sheet.setAttribute("aria-hidden", "true");
    lockBody();
    clearTimeout(S.sheetHideTimer);
    S.sheetHideTimer = setTimeout(function () {
      if (!S.sheetOpen) sheet.classList.add("hidden");
    }, 280);
  }

  function optRow(icon, title, sub, active, attrs) {
    return '<button class="opt' + (active ? " on" : "") + '" ' + (attrs || "") + ">" +
      '<span class="opt-ic">' + esc(icon) + "</span>" +
      '<span class="opt-txt"><b>' + esc(title) + "</b>" + (sub ? "<span>" + esc(sub) + "</span>" : "") + "</span>" +
      (active ? ICON.check : "") + "</button>";
  }

  function openQualitySheet() {
    var pb = S.playback;
    if (!pb || !pb.qualities.length) { toast("No other quality available"); return; }
    var html = '<div class="sheet-title">Quality</div><div class="sheet-sub">Pick a stream tier. SuperBox remembers the last explicit choice.</div><div class="opt-list">' +
      pb.qualities.map(function (q, i) {
        var sub = [q.format || "MP4"];
        if (q.size) sub.push(fmtSize(q.size));
        if (q.codec) sub.push(q.codec);
        return optRow(q.height ? q.height + "p" : "Auto", qualityLabel(q), sub.join(" · "),
          !!(pb.quality && pb.quality.id === q.id), 'data-qi="' + i + '"');
      }).join("") + "</div>";
    openSheet(html, function (root) {
      $$("[data-qi]", root).forEach(function (b) {
        b.onclick = function () { switchQuality(pb.qualities[num(b.getAttribute("data-qi"), 0)]); };
      });
    });
  }

  function openAudioSheet() {
    var pb = S.playback;
    if (!pb) return;
    var html = '<div class="sheet-title">Audio</div><div class="sheet-sub">Choose a dub or the original track.</div><div class="opt-list">' +
      pb.audioTracks.map(function (a, i) {
        var sub = a.original ? "Original track" : "Dubbed audio";
        return optRow(a.lanCode ? a.lanCode.toUpperCase() : "AUD", a.lanName || "Audio", sub,
          !!(pb.audio && pb.audio.subjectId === a.subjectId), 'data-ai="' + i + '"');
      }).join("") + "</div>";
    openSheet(html, function (root) {
      $$("[data-ai]", root).forEach(function (b) {
        b.onclick = function () { switchAudio(pb.audioTracks[num(b.getAttribute("data-ai"), 0)]); };
      });
    });
  }

  function episodeSheet(se) {
    var pb = S.playback;
    if (!pb) return;
    var sn = pb.seasons.filter(function (x) { return x.se === se; })[0] || pb.seasons[0];
    if (!sn) return;
    var tabs = pb.seasons.length > 1 ? '<div class="season-tabs" style="padding:0 14px 8px">' + pb.seasons.map(function (x) {
      return '<button class="' + (x.se === sn.se ? "on" : "") + '" data-sheet-season="' + x.se + '">Season ' + x.se + "</button>";
    }).join("") + "</div>" : "";
    var eps = "";
    for (var i = 1; i <= sn.maxEp; i++) {
      var on = pb.se === sn.se && pb.ep === i;
      eps += '<button class="' + (on ? "on" : "") + '" data-sheet-ep="' + i + '">' + i + "</button>";
    }
    var html = '<div class="sheet-title">Episodes</div><div class="sheet-sub">Season ' + sn.se + " · " + sn.maxEp + ' episodes</div>' +
      tabs + '<div class="ep-grid" style="padding:2px 16px 8px">' + eps + "</div>";
    openSheet(html, function (root) {
      $$("[data-sheet-season]", root).forEach(function (b) {
        b.onclick = function () { episodeSheet(num(b.getAttribute("data-sheet-season"), 1)); };
      });
      $$("[data-sheet-ep]", root).forEach(function (b) {
        b.onclick = function () {
          var ep = num(b.getAttribute("data-sheet-ep"), 1);
          if (pb.se === sn.se && pb.ep === ep) { closeSheet(); return; }
          switchEpisode(sn.se, ep);
        };
      });
    });
  }

  function openEpisodesSheet() {
    var pb = S.playback;
    if (!pb || !pb.isSeries) { toast("No episodes for this title"); return; }
    episodeSheet(pb.se);
  }

  function openSpeedSheet() {
    var speeds = [0.5, 0.75, 1, 1.25, 1.5, 2];
    var html = '<div class="sheet-title">Playback speed</div><div class="opt-list">' +
      speeds.map(function (s) {
        return optRow(s + "x", s === 1 ? "Normal" : (s < 1 ? "Slower" : "Faster"), "", S.speed === s, 'data-speed="' + s + '"');
      }).join("") + "</div>";
    openSheet(html, function (root) {
      $$("[data-speed]", root).forEach(function (b) {
        b.onclick = function () {
          S.speed = num(b.getAttribute("data-speed"), 1);
          prefSet("sb.speed", S.speed);
          try { video.playbackRate = S.speed; } catch (e) {}
          pSpeedLabel.textContent = S.speed + "x";
          closeSheet();
          toast("Speed: " + S.speed + "x");
        };
      });
    });
  }

  function openOptionsSheet() {
    var pb = S.playback;
    if (!pb) return;
    var html = '<div class="sheet-title">Player options</div><div class="sheet-sub">' + esc(pb.title || "") + "</div><div class=\"opt-list\">" +
      optRow("HD", "Quality", pb.quality ? qualityLabel(pb.quality) : "Auto", false, 'data-act="quality"') +
      optRow("AUD", "Audio", audioShort(pb.audio), false, 'data-act="audio"') +
      (pb.isSeries ? optRow("EP", "Episodes", "S" + pb.se + " · E" + pb.ep, false, 'data-act="episodes"') : "") +
      optRow("1x", "Playback speed", S.speed + "x", false, 'data-act="speed"') +
      (pb.isSeries ? optRow("▶", "Next episode", "Continue the series", false, 'data-act="next"') : "") +
      optRow("↻", "Rotate screen", "Landscape or portrait", false, 'data-act="rotate"') +
      optRow("i", "Title details", "Open the full detail page", false, 'data-act="details"') +
      "</div>";
    openSheet(html, function (root) {
      $$("[data-act]", root).forEach(function (b) {
        b.onclick = function () {
          var act = b.getAttribute("data-act");
          if (act === "quality") { closeSheet(); setTimeout(openQualitySheet, 120); }
          else if (act === "audio") { closeSheet(); setTimeout(openAudioSheet, 120); }
          else if (act === "episodes") { closeSheet(); setTimeout(openEpisodesSheet, 120); }
          else if (act === "speed") { closeSheet(); setTimeout(openSpeedSheet, 120); }
          else if (act === "next") { closeSheet(); if (!nextEpisode()) toast("This is the last episode"); }
          else if (act === "rotate") { closeSheet(); try { if (window.SBAndroid && window.SBAndroid.toggleOrientation) window.SBAndroid.toggleOrientation(); } catch (e) {} }
          else if (act === "details") {
            var it = pb.item;
            closeSheet();
            closePlayer();
            if (it) openDetail(it);
          }
        };
      });
    });
  }

  function openRowSheet(row) {
    if (!row) return;
    var html = '<div class="sheet-title">' + esc(row.title) + '</div><div class="sheet-sub">' + row.items.length + ' titles</div>' +
      '<div class="grid" style="padding:12px 16px 18px">' + cards(row.items) + "</div>";
    openSheet(html, function (root) {
      $$(".card", root).forEach(function (b) {
        b.onclick = function () {
          closeSheet();
          var it = getItem(b.getAttribute("data-id"));
          if (it) openDetail(it);
        };
      });
    });
  }

  function openAboutSheet() {
    var version = "1.1.0";
    try { if (window.SBAndroid && window.SBAndroid.version) version = window.SBAndroid.version(); } catch (e) {}
    var html = '<div class="sheet-title">About SuperBox</div><div class="sheet-sub">Mobile ' + esc(version) + "</div>" +
      '<div style="padding:8px 20px 10px;color:#b6b6c1;font-size:12.5px;line-height:1.7;user-select:text">' +
      "<p>SuperBox is an ad-free catalogue browser and native-format player for movies, series, anime and live TV.</p>" +
      "<p>It indexes public catalogues and archives — TMDB, AniList, archive.org, YouTube, iptv-org and Free-TV — plus public stream providers. SuperBox does not host any media.</p>" +
      "<p>No account, no watch history and no trackers are used on this device.</p>" +
      '<p style="color:#777782;font-size:11px;margin-top:16px">Built for touch · 2026</p></div>';
    openSheet(html);
  }

  // ---------------------------------------------------------------- search
  function openSearch() {
    S.searchOpen = true;
    searchPage.classList.remove("hidden");
    searchPage.setAttribute("aria-hidden", "false");
    searchInput.value = "";
    searchClear.classList.add("hidden");
    searchResults.innerHTML = "";
    renderSearchHint();
    lockBody();
    setTimeout(function () {
      try { searchInput.focus(); } catch (e) {}
    }, 120);
    loadHome().then(loadMoreIndex).catch(function () {});
  }

  function closeSearch(silent) {
    if (!S.searchOpen) return;
    S.searchOpen = false;
    searchPage.classList.add("hidden");
    searchPage.setAttribute("aria-hidden", "true");
    try { searchInput.blur(); } catch (e) {}
    lockBody();
  }

  function renderSearchHint() {
    if (!searchHint) return;
    if (S.searchOpen && S.index.length) {
      var picks = S.index.slice(0, 10);
      searchHint.innerHTML = '<h3>Trending searches</h3><div class="chips">' +
        picks.map(function (it) { return '<button class="chip" data-q="' + esc(it.t) + '">' + esc(it.t) + "</button>"; }).join("") + "</div>";
    } else {
      searchHint.innerHTML = '<h3>Search SuperBox</h3><div style="color:#8d8d98;font-size:12px">Find a movie, series or anime.</div>';
    }
  }

  function renderSearch(q) {
    S.searchQuery = q;
    S.searchToken++;
    var token = S.searchToken;
    if (!q) {
      searchResults.innerHTML = "";
      renderSearchHint();
      return;
    }
    searchHint.innerHTML = "";
    var words = q.toLowerCase().split(/\s+/).filter(Boolean);
    var matches = S.index.filter(function (it) {
      var h = (it.t + " " + it.genre + " " + it.country + " " + it.year).toLowerCase();
      return words.every(function (w) { return h.indexOf(w) >= 0; });
    });
    matches.sort(function (a, b) {
      var at = a.t.toLowerCase().indexOf(q.toLowerCase()) === 0 ? 0 : 1;
      var bt = b.t.toLowerCase().indexOf(q.toLowerCase()) === 0 ? 0 : 1;
      if (at !== bt) return at - bt;
      return num(b.rating, 0) - num(a.rating, 0);
    });
    matches = matches.slice(0, 60);
    var html = matches.length ? cards(matches) :
      (q.length < 2 ? '<div class="empty" style="grid-column:1/-1"><b>Keep typing</b>Search the whole SuperBox library.</div>' : "");
    searchResults.innerHTML = html + '<div id="libSearchBlock" class="lib-search-block"></div>';
    if (q.length < 2 || !window.LIB || !window.LIB.searchAll) return;
    var block = document.getElementById("libSearchBlock");
    if (!block) return;
    block.innerHTML = '<div class="lib-search-head"><i class="lib-spin"></i> Searching the full library…</div>';
    window.LIB.searchAll(q).then(function (list) {
      if (token !== S.searchToken || !block.isConnected) return;
      list = (list || []).slice(0, 60);
      if (!list.length) {
        block.innerHTML = matches.length ? "" : '<div class="empty"><b>No results</b>Try a shorter title or a different spelling.</div>';
        return;
      }
      var libCards = window.LIB.cards ? window.LIB.cards(list) : "";
      block.innerHTML = '<div class="section-head"><h2>From the library <em>' + list.length + '</em></h2></div>' +
        '<div class="grid">' + libCards + '</div>';
    }).catch(function () {
      if (token === S.searchToken && block.isConnected) block.innerHTML = "";
    });
  }

  // ---------------------------------------------------------------- events
  function onViewClick(e) {
    var cardEl = e.target.closest(".card[data-id]");
    if (cardEl) {
      var it = getItem(cardEl.getAttribute("data-id"));
      if (it) openDetail(it);
      return;
    }
    var heroPlay = e.target.closest("[data-hero-play]");
    if (heroPlay) {
      var b1 = S.banners[num(heroPlay.getAttribute("data-hero-play"), 0)];
      if (b1) startPlaybackFromItem(b1);
      return;
    }
    var heroInfo = e.target.closest("[data-hero-info]");
    if (heroInfo) {
      var b2 = S.banners[num(heroInfo.getAttribute("data-hero-info"), 0)];
      if (b2) openDetail(b2);
      return;
    }
    var rowBtn = e.target.closest("[data-row]");
    if (rowBtn) {
      var r = S.homeRows[num(rowBtn.getAttribute("data-row"), 0)];
      if (r) openRowSheet(r);
      return;
    }
    var go = e.target.closest("[data-go]");
    if (go) {
      var g = go.getAttribute("data-go");
      if (g === "movies" || g === "series" || g === "anime") switchTab(g);
      else if (g === "live") {
        if (window.LIB && window.LIB.openLive) window.LIB.openLive();
      } else if (g === "adult") {
        if (window.LIB && window.LIB.openAdult) window.LIB.openAdult();
      } else {
        var targetTitle = g === "trending" ? "Trending" : "Cinema";
        var idx = -1;
        S.homeRows.forEach(function (row, i) { if (idx < 0 && row.title.toLowerCase().indexOf(targetTitle.toLowerCase()) >= 0) idx = i; });
        if (idx >= 0) {
          $$("#homeChips .chip").forEach(function (c) { c.classList.toggle("on", c === go); });
          var el = document.getElementById("row-" + idx);
          if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }
      return;
    }
    var cat = e.target.closest("[data-cat]");
    if (cat) {
      var tab = S.tab;
      var data = S.tabData[tab];
      if (!data) return;
      var name = cat.getAttribute("data-cat");
      S.catByTab[tab] = name;
      $$("#catChips .chip").forEach(function (c) { c.classList.toggle("on", c === cat); });
      var found = data.cats.filter(function (c) { return c.name === name; })[0] || data.cats[0];
      var grid = document.getElementById("gridWrap");
      if (grid && found) grid.innerHTML = cards(found.items);
      var count = document.getElementById("gridCount");
      if (count && found) count.textContent = found.items.length + " titles · Ad-free";
      return;
    }
    var retry = e.target.closest("[data-retry]");
    if (retry) {
      renderHome();
      return;
    }
    var setting = e.target.closest("[data-setting]");
    if (setting) {
      var what = setting.getAttribute("data-setting");
      if (what === "quality") {
        var order = [0, 480, 720, 1080];
        var pos = order.indexOf(num(S.quality, 0));
        S.quality = order[(pos + 1) % order.length];
        prefSet("sb.quality", S.quality);
        var rt = $(".rt", setting);
        if (rt) rt.textContent = qualityText(S.quality);
        toast("Default quality: " + qualityText(S.quality));
      } else if (what === "autoplay") {
        S.autoplay = !S.autoplay;
        prefSet("sb.autoplay", S.autoplay ? "1" : "0");
        var sw = $(".switch", setting);
        if (sw) sw.classList.toggle("on", S.autoplay);
        toast("Autoplay next episode " + (S.autoplay ? "on" : "off"));
      } else if (what === "clear") {
        prefDel("sb.quality");
        prefDel("sb.speed");
        S.quality = 0;
        S.speed = 1;
        toast("Temporary data cleared");
        renderMe();
      } else if (what === "about") {
        openAboutSheet();
      } else if (what === "vpn") {
        openVpnSheet();
      } else if (what === "sources") {
        if (window.LIB && window.LIB.openSources) window.LIB.openSources();
        else openAboutSheet();
      } else if (what === "refresh") {
        toast("Refreshing catalogue...");
        loadHome(true).then(function () {
          toast("Catalogue refreshed");
          switchTab("home");
        }).catch(function () { toast("Could not refresh right now"); });
      }
      return;
    }
  }

  function onDetailClick(e) {
    var cardEl = e.target.closest(".card[data-id]");
    if (cardEl) {
      var it = getItem(cardEl.getAttribute("data-id"));
      if (it) openDetail(it);
      return;
    }
    if (e.target.closest("[data-dback]")) { closeDetail(); return; }
    var data = S.detailData;
    if (!data) return;
    if (e.target.closest("[data-dplay]")) {
      startPlayback(data.s, data.item, data.seasons.length ? data.seasons[0].se : 0, data.isSeries ? 1 : 0, {});
      return;
    }
    if (e.target.closest("[data-dtrailer]")) {
      startTrailer(data.s, data.item);
      return;
    }
    if (e.target.closest("[data-ddesc]")) {
      var d = document.getElementById("dDesc");
      if (d) {
        var on = d.classList.toggle("open");
        e.target.closest("[data-ddesc]").textContent = on ? "Show less" : "Read more";
      }
      return;
    }
    var epBtn = e.target.closest("[data-ep]");
    if (epBtn) {
      var ep = num(epBtn.getAttribute("data-ep"), 1);
      var se2 = num(epBtn.getAttribute("data-season"), S.detailSeason || 1);
      startPlayback(data.s, data.item, se2, ep, {});
      return;
    }
    var season = e.target.closest("[data-season]");
    if (season) {
      var se = num(season.getAttribute("data-season"), 1);
      S.detailSeason = se;
      $$(".season-tabs [data-season]", detail).forEach(function (b) {
        b.classList.toggle("on", num(b.getAttribute("data-season"), 0) === se);
      });
      var grid = document.getElementById("dEpGrid");
      if (grid) grid.innerHTML = epGridMarkup(data, se);
      var playBtn = $("[data-dplay]", detail);
      if (playBtn) playBtn.innerHTML = ICON.play + " Play S" + se + "E1";
      return;
    }
  }

  function onSearchClick(e) {
    var cardEl = e.target.closest(".card[data-id]");
    if (cardEl) {
      var it = getItem(cardEl.getAttribute("data-id"));
      if (it) { closeSearch(); openDetail(it); }
      return;
    }
    var q = e.target.closest("[data-q]");
    if (q) {
      searchInput.value = q.getAttribute("data-q");
      searchClear.classList.remove("hidden");
      renderSearch(searchInput.value.trim());
      return;
    }
    if (e.target.closest("#searchBack")) { closeSearch(); return; }
  }

  function onPlayerTap(e) {
    if (pError && !pError.classList.contains("hidden")) return;
    var now = Date.now();
    var x = e.clientX;
    var w = window.innerWidth;
    if (now - (onPlayerTap.last || 0) < 320 && Math.abs(x - (onPlayerTap.lastX || 0)) < 70) {
      clearTimeout(onPlayerTap.single);
      onPlayerTap.last = 0;
      if (x < w * 0.36) {
        seekBy(-10);
        showGesture("−10s");
      } else if (x > w * 0.64) {
        seekBy(10);
        showGesture("+10s");
      } else {
        togglePlay();
      }
      return;
    }
    onPlayerTap.last = now;
    onPlayerTap.lastX = x;
    clearTimeout(onPlayerTap.single);
    onPlayerTap.single = setTimeout(toggleControls, 240);
  }

  function togglePlay() {
    if (!video) return;
    if (video.paused || video.ended) {
      if (video.ended) { try { video.currentTime = 0; } catch (e) {} }
      tryPlay();
      showControls();
    } else {
      video.pause();
      showControls();
    }
  }

  function seekBy(sec) {
    if (!video) return;
    var d = video.duration;
    if (!isFinite(d) || d <= 0) return;
    video.currentTime = Math.max(0, Math.min(d - 0.2, video.currentTime + sec));
    updateSeekUI();
    showControls();
  }

  function updateSeekUI() {
    if (!video) return;
    var d = num(video.duration, 0);
    var c = num(video.currentTime, 0);
    pCur.textContent = fmtTime(c);
    pDur.textContent = fmtTime(d);
    var pct = d > 0 ? (c / d) * 100 : 0;
    pSeek.value = String(Math.round(pct * 10));
    pSeek.style.setProperty("--p", pct.toFixed(2) + "%");
  }

  function onMediaError() {
    var pb = S.playback;
    if (!pb) return;
    showSpinner(false);
    if (pb.trailer) {
      showPlayerError("The trailer could not be played.");
      return;
    }
    if (hlsEngine && pb.format === "hls" && !pb._mediaFix) {
      pb._mediaFix = 1;
      try { hlsEngine.recoverMediaError(); return; } catch (e) {}
    }
    pb.failCount = (pb.failCount || 0) + 1;
    if (pb.failCount <= 6 && tryNextQuality("This quality failed — trying another")) return;
    var code = video.error ? video.error.code : 0;
    var msg = "This stream could not be played.";
    if (code === 2) msg = "The stream stopped responding. Try another quality or episode.";
    if (code === 3) msg = "The device could not decode this video.";
    if (code === 4) msg = "This video format is not supported by the player.";
    showPlayerError(msg);
  }

  // ---------------------------------------------------------------- init
  function bindEvents() {
    document.getElementById("brand").onclick = function () { switchTab("home"); };
    document.getElementById("searchBtn").onclick = openSearch;
    document.getElementById("meBtn").onclick = function () { switchTab("me"); };
    $$("#tabbar .tab").forEach(function (b) {
      b.onclick = function () { switchTab(b.getAttribute("data-tab")); };
    });

    view.addEventListener("click", onViewClick);
    detail.addEventListener("click", onDetailClick);
    searchPage.addEventListener("click", onSearchClick);
    searchResults.addEventListener("click", onSearchClick);
    searchHint.addEventListener("click", onSearchClick);

    searchInput.addEventListener("input", function () {
      var q = searchInput.value.trim();
      searchClear.classList.toggle("hidden", !q);
      clearTimeout(S.searchTimer);
      S.searchTimer = setTimeout(function () { renderSearch(q); }, 150);
    });
    searchInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        clearTimeout(S.searchTimer);
        renderSearch(searchInput.value.trim());
        try { searchInput.blur(); } catch (err) {}
      }
    });
    searchClear.onclick = function () {
      searchInput.value = "";
      searchClear.classList.add("hidden");
      renderSearch("");
      searchInput.focus();
    };

    document.getElementById("sheetBackdrop").onclick = closeSheet;

    pPlay.onclick = togglePlay;
    document.getElementById("pBack").onclick = closePlayer;
    document.getElementById("pMore").onclick = openOptionsSheet;
    document.getElementById("pRew").onclick = function () { seekBy(-10); showGesture("−10s"); };
    document.getElementById("pFwd").onclick = function () { seekBy(10); showGesture("+10s"); };
    document.getElementById("pQuality").onclick = openQualitySheet;
    document.getElementById("pAudio").onclick = openAudioSheet;
    pEps.onclick = openEpisodesSheet;
    document.getElementById("pSpeed").onclick = openSpeedSheet;
    document.getElementById("pRotate").onclick = function () {
      try { if (window.SBAndroid && window.SBAndroid.toggleOrientation) window.SBAndroid.toggleOrientation(); } catch (e) {}
    };
    document.getElementById("pRetry").onclick = function () {
      var pb = S.playback;
      hidePlayerError();
      if (!pb) return;
      pb.tried = {};
      pb.failCount = 0;
      if (pb.restart && !pb.quality) pb.restart();
      else loadStream(num(video.currentTime, 0), true);
    };
    document.getElementById("pErrorBack").onclick = closePlayer;
    document.getElementById("pTap").addEventListener("click", onPlayerTap);
    pSeek.addEventListener("input", function () {
      var d = num(video.duration, 0);
      if (d > 0) {
        video.currentTime = (num(pSeek.value, 0) / 1000) * d;
        updateSeekUI();
      }
    });

    video.addEventListener("loadedmetadata", function () {
      var pb = S.playback;
      if (!pb) return;
      try { video.playbackRate = S.speed; } catch (e) {}
      pDur.textContent = fmtTime(video.duration);
      if (pb.pendingSeek > 1 && isFinite(video.duration) && pb.pendingSeek < video.duration - 0.5) {
        try { video.currentTime = pb.pendingSeek; } catch (e) {}
      }
      pb.pendingSeek = 0;
      updateSeekUI();
      if (pb.wantPlay) tryPlay();
    });
    video.addEventListener("canplay", function () {
      showSpinner(false);
      if (S.playback && S.playback.wantPlay) tryPlay();
    });
    video.addEventListener("playing", function () {
      showSpinner(false);
      updatePlayIcon();
      showControls();
    });
    video.addEventListener("pause", function () {
      updatePlayIcon();
      showControls();
    });
    video.addEventListener("waiting", function () {
      if (S.playback) showSpinner(true);
    });
    video.addEventListener("timeupdate", updateSeekUI);
    video.addEventListener("ended", function () {
      updatePlayIcon();
      showControls();
      var pb = S.playback;
      if (pb && pb.isSeries && S.autoplay) {
        toast("Next episode...");
        clearTimeout(S.autoNextTimer);
        S.autoNextTimer = setTimeout(function () {
          if (S.playback === pb && S.playerOpen) nextEpisode();
        }, 1100);
      }
    });
    video.addEventListener("error", onMediaError);

    document.addEventListener("visibilitychange", function () {
      if (document.hidden && video && !video.paused) video.pause();
    });
  }

  function switchTab(tab) {
    if (!tab) tab = "home";
    if (["home", "movies", "series", "anime", "reading", "sources", "me"].indexOf(tab) < 0) tab = "home";
    if (S.playerOpen) closePlayer();
    closeSheet();
    if (S.searchOpen) closeSearch(true);
    if (S.detailOpen) closeDetail(true);
    if (window.READER) { try { window.READER.close(); } catch (e) {} }
    S.tab = tab;
    $$("#tabbar .tab").forEach(function (b) {
      var on = b.getAttribute("data-tab") === tab;
      b.classList.toggle("active", on);
      if (on) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
    window.scrollTo(0, 0);
    if (tab === "home") renderHome();
    else if (tab === "me") renderMe();
    else if (tab === "reading") renderReading();
    else if (tab === "sources") renderSources();
    else renderLibrary(tab);
  }

  function renderReading() {
    clearInterval(S.heroTimer);
    view.innerHTML = '<div id="readingHost"></div>';
    if (window.READER) {
      window.READER.render(document.getElementById("readingHost"));
    } else {
      view.innerHTML = errorView("Reading is unavailable", "The reader module failed to load. Restart SuperBox and try again.");
    }
    removeBoot();
  }

  function renderSources() {
    clearInterval(S.heroTimer);
    view.innerHTML = '<div id="sourcesHost"></div>';
    if (window.SOURCES_HUB) {
      window.SOURCES_HUB.render(document.getElementById("sourcesHost"));
    } else {
      view.innerHTML = errorView("Sources are unavailable", "The source directory failed to load. Restart SuperBox and try again.");
    }
    removeBoot();
  }

  function startPlaybackFromItem(item) {
    if (!item) return;
    fetchDetail(item).then(function (data) {
      startPlayback(data.s, data.item, data.seasons.length ? data.seasons[0].se : 0, data.isSeries ? 1 : 0, {});
    }).catch(function () { toast("Could not open this title"); });
  }

  window.sbBack = function () {
    if (window.READER && window.READER.back()) return true;
    if (window.LIB && window.LIB.back && window.LIB.back()) return true;
    if (S.sheetOpen) { closeSheet(); return true; }
    if (S.playerOpen) { closePlayer(); return true; }
    if (S.searchOpen) { closeSearch(); return true; }
    if (S.detailOpen) { closeDetail(); return true; }
    if (S.tab !== "home") { switchTab("home"); return true; }
    return false;
  };
  window.sbPause = function () {
    try { if (video && !video.paused) video.pause(); } catch (e) {}
  };

  function init() {
    S.quality = num(prefGet("sb.quality"), 0);
    S.autoplay = prefGet("sb.autoplay") !== "0";
    S.speed = num(prefGet("sb.speed"), 1);
    bindEvents();
    startVpnGate();
    renderHome();
    loadHome().then(function () {
      removeBoot();
    }).catch(function () { removeBoot(); });
    setTimeout(removeBoot, 7000);
  }

  window.SBApp = {
    playDirect: playDirect,
    openWeb: openWeb,
    openLadder: openLadder,
    toast: toast,
    openSheet: openSheet,
    closeSheet: closeSheet,
    switchTab: switchTab,
    esc: esc,
    enc: enc,
    imgUrl: imgUrl,
    num: num,
    state: S,
    lockBody: lockBody
  };

  init();
})();
