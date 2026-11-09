# Changelog

All notable changes to SuperBox are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

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

- Desktop: Rule34, MMS/JAV, AWS MP4, Hentai and AI lanes all started playback
  headless and muted, with teardown within one second.
- Desktop first paint: 261 ms, 84 cards, lazy rows hydrate on scroll.
- APK: four ABIs, 48/48 uncompressed native libraries, `classes.dex` present,
  signature verified with `apksigner`.

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
