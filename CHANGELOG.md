# Changelog

All notable changes to SuperBox are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.3.0] — 2026-11-12

The everywhere release: an embedded open-source VPN, Moviebox restored on both
platforms, all 47 `source.txt` catalogues and a native MangaDex/WEBTOON
Reading room.

### Added

- Shield VPN: bundled `usque` v4.2.1 (GPL-3.0) speaking Cloudflare WARP over
  MASQUE, with anonymous registration and a UI gate that stays closed until
  `warp=true`.
- 13 region profiles (Global, US, Canada, UK, Australia, India, Germany, Japan,
  Singapore, Hong Kong, South Korea, France, Brazil), 12 endpoint profiles per
  region, rotated for redundancy.
- Desktop VPN transport: hidden `usque l4-http-proxy` on `127.0.0.1:46950`,
  `undici` proxy agent for Node and `session.setProxy` for Chromium.
- Android VPN transport: `libusque.so` per ABI, `LocalServer` upstream proxy
  and `androidx.webkit` `ProxyController` for the WebView.
- Moviebox Spotlight on desktop and Android: hero, 50-card front page, 16 rows,
  detail pages, seasons, episodes and audio tracks.
- Moviebox media proxy with a 2 MB first window, 8 MB follow-ups, 128 KB chunks
  and 24 parallel range workers; scoped direct split tunnel for the CDN.
- 47-source directory: 23 movies/TV, 10 anime and 14 manga/manhwa, searchable
  and grouped, with every URL from `source.txt`.
- Reading room: MangaDex API catalogue (49,463 titles at verification),
  WEBTOON catalogue, genre/age filters, cached covers and pages, native readers
  and an external-chapter fallback card.
- Reading filters: choose a language (English first), a format (Manga, Manhwa,
  Manhua, Other) and a genre; requests are sequenced and aborted so rapid
  changes can never paint a stale result.
- IPv6-first Shield transport on both platforms: `2606:4700:103::2` is tried
  first (10 s budget), then the IPv4 ladder.
- Hentai.tv signed-URL probe: an offscreen iframe on desktop and a 1×1 WebView
  on Android capture the short-lived `?verify=` URL minted by nhplayer.
- Rule34 quality ladder parsing (`_360`, `_480p`, `_720p`, …) with the signed
  `?v-acctoken` preserved, and de-duplicated rows.
- Universal Android APK with all four ABIs, bundled VPN per ABI and
  `versionCode=4`.
- `docs/RELEASE_NOTES_v1.3.0.md` and a rewritten `docs/VERIFY.md`.

### Changed

- Auto-region switching is preference-only while the tunnel is healthy; a
  healthy tunnel is no longer torn down mid-session.
- VPN stop/restart waits for port release (desktop 2.6 s, Android 1.2 s plus
  900 ms between endpoint attempts).
- MangaDex covers are rewritten to the working at-home host, learned once and
  cached in `localStorage`.
- MangaDex catalogue requests retry once after 1.4 s to survive rate limits.

### Fixed

- Android Moviebox media path: signed `&t=` URLs are used unescaped, and
  `/raw` returns real `206 video/mp4` windows instead of anti-bot HTML.
- Desktop Moviebox retry bookkeeping (`session.tried[q.id]`) and stale play
  payload handling.
- Android image cache rejects anti-bot HTML with magic-byte sniffing instead of
  painting a broken image.
- External-only MangaDex chapters no longer open a blank reader.
- Rule34 rows no longer repeat titles or show model/category tiles, and play
  the highest signed rendition instead of the 360p default.
- Hentaicity 3D / CG and Futanari rows use the final `videos/straight/*` URLs
  instead of the `301` redirect targets.
- Hentaicity playback on Android: the signed
  `.../.mp4.urlset/master.m3u8?hash=` URL is preserved end to end and loaded
  through hls.js instead of being truncated to `.mp4`.
- Android Home / Movies / Series / Anime shelves tag every TMDB and archive
  descriptor with its resolver, so no header row is left empty.
- Hentai.tv playback on Android: the bare r2 mp4 is replaced by the signed
  `?verify=` URL captured from nhplayer and played directly in the WebView
  (the r2 CDN rejects Java's TLS fingerprint).
- Hentai.tv page-two row no longer duplicates the newest row.

## [1.2.0] — 2026-11-09

The hardening release: faster cold starts, self-healing artwork, a universal
fat APK and a playback ladder that keeps trying until a source actually plays.

### Added

- Universal fat APK: every ABI (arm64-v8a, armeabi-v7a, x86, x86_64) plus a
  bundled FFmpeg decoder archive, stored uncompressed for zero-copy loading.
- Stale-while-revalidate row cache on both platforms (`sb.rows.v2`), so shelves
  paint from localStorage first and refresh silently.
- Viewport-driven row hydration: the first four rows load eagerly, the rest
  start ~700 px before they scroll into view, cutting launch requests sharply.
- Hover-intent prefetch for 18+ cards on desktop (episode/JAV/Rule34/AI).
- Three-tier artwork fallback: local `/img` cache → origin → images.weserv.nl.
- Native Android `video.onerror` handling, 18 s/45 s load watchdogs and a
  `fallback → embed → page` handoff when a direct stream never starts.
- Desktop stall watchdog rotates sources only after 15 s of zero progress
  (45 s absolute cap) and cleans media listeners between sources.
- Headless verification mode (`SB_HEADLESS=1`) with process-level audio mute,
  hidden window and CDP on port 9333.

### Changed

- Desktop releases are NSIS-only; the portable target and split builds are gone.
- Eporner extraction uses an embed-only fast path, a 4-minute resolver cache,
  15-minute signed-file reuse and automatic re-signing on failure.
- `/ep` requests carry a 9 s timeout and purge cached URLs on 502 responses.
- Windows and Android versions bumped to 1.2.0; APK `versionCode=3`.

### Fixed

- Galleries and 18+ lanes that never resolved: JAV now races the backend route
  against the client parser on desktop, with `/extract` playback.
- Infinite loading shelves: every row has a hard ceiling and paints cache
  before any network work starts.
- Memory/listener leaks in both players when switching sources.
- Dead-image replay and stuck initials placeholders across all sections.

### Verified

- Windows Setup installed silently, reports 1.2.0, first paint 276 ms with
  104 cards.
- Desktop: Rule34, MMS/JAV, AWS MP4, Hentai and AI lanes all started playback
  headless and muted, with teardown within one second.
- Android: APK installed on the Android 14 emulator, cold launch 4.5 s, visible
  artwork resolved through the retry chain.
- Android player: direct MP4 advanced 0 → 1.0 s → 2.5 s and HLS advanced
  0 → 0.9 s → 2.8 s, both muted and both stopped inside the 10-second cap.
- APK: four ABIs, 48/48 uncompressed native libraries, decoder archive and
  `classes.dex` present, signature verified with `apksigner`.

## [1.1.0] — 2026-11-05

The unification release: one library, faster startup, reliable artwork, working
HLS/DASH/MP4 playback and a hardened Android build.

### Added

- Unified `window.LIB` library layer. Movies, Series and Anime now render the
  extra-library rows inline, with Live TV / 18+ / Sources filter chips and
  combined search. The separate Vault UI, drawer group and hero are gone.
- Bundled `hls.js` and `dash.js` engines with lazy loading, media-error
  recovery, network recovery and an ordered quality fallback chain.
- Disk caches in `LocalServer` for API JSON, TMDB responses, proxied pages,
  images, HLS playlists and DASH manifests.
- Per-session localhost token. Privileged endpoints reject requests without it,
  and the token is injected into `index.html` at serve time.
- AES-256-GCM encryption for every JavaScript asset at rest, plus obfuscation
  of first-party scripts in the Android asset pipeline.
- Image retry handling (`SBIMG`) so transient CDN failures do not leave cards
  stuck on their initials.
- New infinity app icon across every Android mipmap and Windows executable.

### Changed

- `vault.js` became `library.js`; the old `window.WA` namespace is removed.
- Home JSON paints instantly from `localStorage`, then refreshes in the
  background. Cold start measured 1.39 s on the test emulator.
- `/stream` now uses 128 KB parallel chunks and a small first window, cutting
  MP4 playback start from ~45 s to ~9 s on the reference emulator.
- Library fetches go through the local proxy, eliminating repeated YouTube and
  allorigins CORS failures.
- The Cloudflare challenge detector no longer rejects large pages that merely
  contain a `<noscript>` warning, which fixed YouTube page parsing.
- Dead Vault/drawer CSS was removed from the Android stylesheet.
- Desktop version bumped to 1.1.0; the baked-in TMDB key was removed from the
  renderer catalogue (the local proxy injects it server-side).

### Fixed

- The `index.html` fetch wrapper only signed relative URLs, so library calls
  made with an absolute `http://127.0.0.1:<port>` base were rejected with 403.
  It now signs same-origin absolute URLs too, restoring Live TV and every
  scraper fetch.

### Verified

- Android: 102-title Movies tab with merged library rows, posters loading via
  retry, live HLS channel playing, 480p episode playing, no CORS spam.
- Live TV: 845 India channels parsed through `/page`, 4 SIDES TV played.
- APK: `versionCode=2`, `versionName=1.1.0`, one `classes.dex`, only `.js.enc`
  assets, R8 applied.
- Windows: installer and portable builds launch, load the catalogue and carry
  the new icon and version metadata.

## [1.0.0] — 2026-11-05

The first standalone SuperBox release. One brand, two apps, one library.

### Added

- **SuperBox Vault** — a separate library section with its own drawer group,
  hero, ten curated sections and an infinity motif.
- **Library sources** sheet, reachable from the Vault hero, the drawer and the
  Me page. It names every catalogue behind the Vault.
- Gold **infinite aura** visual system: breathing logo glow, aura rings, an
  `∞` watermark, source chips and a premium drawer card.
- Native playback for real MP4/HLS streams, with an ordered provider ladder
  that rotates past dead shells.
- Touch-first Android UI: five-tab navigation, search, details, seasons,
  episodes, quality/audio/speed sheets and rotation.
- Windows installer with a normal wizard and a freely chosen install folder or
  drive, plus a no-install portable build.

### Changed

- The extended library is branded **SuperBox Vault** everywhere. Old library
  and upstream brand names were removed from the shipped UI.
- `watcha.js` became `vault.js`; the internal `WA` namespace is kept for
  stability.
- The Android APK is signed with the SuperBox release key and verified before
  packaging.

### Verified

- Spotlight: 226 cards on Home; Movies 103, Series 115, Anime 26.
- Vault: 5 rows / 104 cards on Home; Web Series 9 rows / 193 titles; Live TV
  17 groups / 200 channels.
- Vault detail, sources sheet and native playback tested on `emulator-5554`.
- APK signature and SHA-256 recorded in [docs/VERIFY.md](docs/VERIFY.md).

[1.0.0]: https://github.com/mohdziauddin2006-cloud/superbox/releases/tag/v1.0.0
