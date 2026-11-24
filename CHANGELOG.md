<div align="center">
  <img src="docs/hero-1.4.svg" alt="SuperBox 1.4.0" width="640">
  <h1>CHANGELOG</h1>
  <p><b>One box. Infinite library.</b></p>
  <p>
    <img alt="Version 1.4.0" src="https://img.shields.io/badge/release-v1.4.0-FFC105?style=flat-square&labelColor=0B0B0F">
    <img alt="Offline ONNX AI" src="https://img.shields.io/badge/AI-offline%20ONNX-FFC105?style=flat-square&labelColor=0B0B0F">
    <img alt="Embedded VPN" src="https://img.shields.io/badge/VPN-embedded%20WARP-FFC105?style=flat-square&labelColor=0B0B0F">
    <img alt="Zero ads" src="https://img.shields.io/badge/ads-zero-FFC105?style=flat-square&labelColor=0B0B0F">
  </p>
</div>

All notable changes to SuperBox are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.4.0] — 2026-11-24

**The intelligence release.** Recommendations now run entirely on-device, the
reader gained a complete HUD, every catalogue ships behind one private shell,
and the VPN became a real control panel instead of a status light.

### Added

- **Offline AI recommendations.** The quantized q8 `all-MiniLM-L6-v2` ONNX
  model, tokenizer, vocabulary and runtime are bundled with Windows and
  Android. Loading uses `local_files_only: true`; there is no inference key,
  no cloud request and no external model download.
- **384-dimensional semantic matching.** Candidate shortlists are embedded in
  batches of 16, documents are cached, and a query is a single dense pass.
  Measured: 42 ms to index 16 titles cold, 10 ms warm on Windows; 151 ms first
  and 19 ms warm on Android.
- **12–16 similar previews.** The recommendation section paints poster cards
  with percentage match pills and joins the existing detail page instead of
  replacing it.
- **Independent vector partitions.** Safe and adult metadata are embedded,
  stored and queried separately. Adult items are rejected by the safe index,
  and the isolated store stays empty unless the 18+ vault is active.
- **Reader HUD.** Paged, vertical and continuous modes with a chapter drawer,
  progress, chapter jump and mode-aware layout on both platforms.
- **Reader input parity.** Arrow keys, Page Up/Down, Space and Home/End on
  desktop; guarded swipe navigation on touch. Keyboard and swipe move exactly
  one page in paged modes and one viewport in continuous modes.
- **Strict language filtering.** Feeds request the chosen language and verify
  hosted pages; chapters without hosted pages are dropped instead of opening a
  blank reader.
- **Episode range tabs.** Seasons plus `1–50`, `51–100` and `101+` pagination,
  generated from the real episode total on desktop and Android.
- **Non-blocking metadata fallback.** When the primary metadata service is slow
  or unreachable, the catalogue answer is used and the detail page still
  renders; the request is capped and never blocks first paint.
- **Unified scoped search.** Every search surface can scope itself and clears
  in one tap. Deep search shares the bar and opens through the age gate.
- **VPN control panel.** Status chip, pulse ring, power copy, manual ON/OFF,
  live latency badge, Auto-Region switch and searchable region cards.
- **Complete catalogue activation.** Native adapters, detail pages, chapter
  lists and readers for every reading catalogue, with desktop and Android
  parity and ordered page extraction.
- **Private adult vault.** Adult reading catalogues sit together only inside
  **18+ Reading**, behind the age gate, with pagination, lazy covers, chapter
  fallback, image rotation and English-tag verification. A separate **18+
  Video** search is isolated the same way. Standard Reading and Kids contain
  zero adult items.

### Changed

- The AI Studio backend is merged into both apps instead of running beside
  them: one renderer state, one adult mode, one reader registry and one scoped
  search path.
- Desktop and Android keep a separate adult provider registry. Provider lookup
  searches both registries; the public interface never sees the adult one.
- AI candidate embedding moved from one inference pass per title to batched
  passes of 16, with cached dense vectors on re-index.
- SBAI index requests now allow a 9 s budget and similarity requests 2.5 s;
  local scoring still answers immediately if the BFF is busy.
- Android now serves `.mjs` as JavaScript and `.wasm` as `application/wasm`,
  and the asset reader accepts up to 40 MB for the ONNX model and asyncify
  runtime.
- The internal catalogue directory is reachable from Settings (Windows) and Me
  (Android), and every entry opens through the same in-app shell.
- Reader page caches, covers and chapter lists are scoped to the active
  catalogue and language, preventing cross-catalogue bleed.
- The version is now 1.4.0 everywhere; APK `versionCode=5`.

### Fixed

- `undici` and `TLSSocket` guards: a terminated socket logs once and fails the
  request instead of raising a process-level crash dialog.
- Every outbound fetch has a timeout, retry budget and stream error handler.
- Stale AI results no longer paint after a seed change; a late response is
  discarded by request generation.
- Desktop source overlay closes on Escape and backdrop click, and no longer
  leaves the page scroll locked.
- Android source sheet closes cleanly and restores the previous route.
- Episode rows no longer duplicate when a range tab is reselected, and season
  switches reset the active range.
- Reader HUD mode changes preserve the current page instead of jumping to the
  start.
- The VPN chip reflects manual OFF and direct mode truthfully; the latency
  badge stops polling when the panel is closed.
- A failed ONNX load falls back to the local TF-IDF engine without disabling
  recommendations.
- Mobile AI assets are decrypted before use, so the bundled runtime and model
  load from the encrypted asset store.

### Security

- Adult provider identifiers and endpoints are excluded from the public shell,
  public search and public vector partition.
- The age gate is the only route into adult reading; deep search and the 18+
  video lane reuse the same verification.
- Android privileged routes still require the per-session token, and all
  first-party JavaScript remains encrypted at rest.
- Raw provider URLs are resolved inside the app and never exposed in the UI.

### Verified

- Windows: `mode=onnx`, `Xenova/all-MiniLM-L6-v2`, 384 dimensions; 16 titles
  indexed in 42 ms cold; 16 previews at 98% top match in 10 ms warm.
- Android: bundled ONNX loaded in 907 ms; 384 dimensions; first pass 151 ms,
  warm pass 19 ms, 95% top match.
- Vector isolation: safe index populated, isolated index empty until the 18+
  vault is active.
- Reader: HUD modes, chapter drawer, keyboard and swipe handlers present on
  both platforms.
- Search: scoped inputs and clear controls present on every search surface;
  deep search gated.
- Episodes: `1–50`, `51–100`, `101+` and season selection verified.
- VPN: power control, pulse ring, latency badge, Auto-Region and region search
  verified.
- Catalogue adapters: ordered pages and chapter lists returned within the
  ten-second ceiling.
- JavaScript: every desktop and Android bundle passes `node --check`.
- Java: server, activity, VPN and player sources compile.
- APK: universal, `versionCode=5`, four ABIs, ONNX assets, signature verified.
- Media: every verification stream ran muted and was stopped under 10 seconds.

## [1.3.0] — 2026-11-12

**The everywhere release.** An embedded open-source VPN, restored catalogue
playback on both platforms, every catalogue wired, and a native reading room.

### Added

- Shield VPN: bundled open-source Cloudflare WARP over MASQUE, anonymous
  registration and a gate that stays closed until the tunnel reports healthy.
- 13 region profiles, 12 endpoint profiles per region, rotated for redundancy.
- Desktop transport: hidden local proxy, `undici` agent for Node and Chromium
  proxy configuration, with loopback bypassed.
- Android transport: bundled native core per ABI, loopback upstream proxy and
  WebView proxy routing.
- Catalogue spotlight on both platforms: hero, front-page rows, detail pages,
  seasons, episodes and audio tracks.
- Media proxy with a small first window, larger follow-ups, parallel range
  workers and a scoped direct path for the CDN that rejects VPN egress.
- Searchable internal catalogue directory with stable native rows where an API
  exists and an in-app shell everywhere else.
- Reading room: public catalogue APIs, genre and age filters, cached covers and
  pages, native readers and an external-chapter fallback card.
- Language, format and genre filters with request sequencing and cancellation.
- IPv6-first Shield transport, falling back to the IPv4 ladder.
- Short-lived signed-URL capture for players that mint a verification token.
- Quality ladder parsing, signed-token preservation and de-duplicated rows.
- Universal Android APK with all four ABIs and `versionCode=4`.

### Changed

- Auto-region switching is preference-only while the tunnel is healthy; a
  healthy tunnel is never torn down mid-session.
- VPN stop/restart waits for port release on both platforms.
- Covers are rewritten to the working image host, learned once and cached.
- Catalogue requests retry once to survive rate limits.

### Fixed

- Signed media URLs are used unescaped, and the media route returns real
  `206 video/mp4` windows instead of anti-bot HTML.
- Retry bookkeeping and stale play payload handling.
- Image cache rejects anti-bot HTML with magic-byte sniffing.
- External-only chapters no longer open a blank reader.
- Quality rows no longer repeat titles or show model/category tiles, and play
  the highest signed rendition instead of a low default.
- Signed HLS URLs are preserved end to end instead of being truncated.
- Home shelves tag every descriptor with its resolver, so no header row is
  left empty.
- The signed verification URL is captured and played directly when the media
  CDN rejects the platform TLS fingerprint.

## [1.2.0] — 2026-11-09

**The hardening release.** Faster cold starts, self-healing artwork, a universal
fat APK and a playback ladder that keeps trying until a source actually plays.

### Added

- Universal fat APK: every ABI plus a bundled FFmpeg decoder archive, stored
  uncompressed for zero-copy loading.
- Stale-while-revalidate row cache, so shelves paint from local storage first
  and refresh silently.
- Viewport-driven row hydration: the first rows load eagerly, the rest start
  shortly before they scroll into view.
- Hover-intent prefetch for adult cards on desktop.
- Three-tier artwork fallback: local cache, origin, then image resizer.
- Native video error handling, load watchdogs and a fallback-to-embed-to-page
  handoff when a direct stream never starts.
- Desktop stall watchdog that rotates sources only after zero progress and
  cleans media listeners between sources.
- Headless verification mode with process-level audio mute, a hidden window
  and a debugging port.

### Changed

- Desktop releases are NSIS-only; portable and split builds are gone.
- Signed-file extraction uses a fast path, a resolver cache and reuse with
  automatic re-signing on failure.
- Episode requests carry a timeout and purge cached URLs on gateway errors.
- Version 1.2.0 on both platforms; APK `versionCode=3`.

### Fixed

- Galleries and adult lanes that never resolved now race the backend route
  against the client parser.
- Infinite loading shelves: every row has a ceiling and paints cache before
  network work starts.
- Memory and listener leaks when switching sources.
- Dead-image replay and stuck initials placeholders.

### Verified

- Windows Setup installed silently, reported 1.2.0, first paint 276 ms with
  104 cards.
- Desktop adult lanes started playback headless and muted, with teardown within
  one second.
- Android cold launch 4.5 s; artwork resolved through the retry chain.
- Android direct MP4 and HLS advanced muted and stopped inside the 10-second
  cap.
- APK: four ABIs, native libraries, decoder archive, `classes.dex`, signature
  verified.

## [1.1.0] — 2026-11-05

**The unification release.** One library, faster startup, reliable artwork,
working HLS/DASH/MP4 playback and a hardened Android build.

### Added

- Unified library layer: Movies, Series and Anime render extra-library rows
  inline, with filter chips and combined search.
- Bundled HLS and DASH engines with lazy loading, media-error recovery and an
  ordered quality fallback chain.
- Disk caches for API JSON, metadata, proxied pages, images and manifests.
- Per-session localhost token; privileged endpoints reject requests without it,
  and the token is injected into the page at serve time.
- AES-256-GCM encryption for every JavaScript asset at rest, plus obfuscation
  of first-party scripts.
- Image retry handling so transient CDN failures do not leave cards stuck.
- New infinity app icon across Android mipmaps and the Windows executable.

### Changed

- The old vault namespace was folded into the library layer.
- Home paints from local storage, then refreshes in the background.
- Stream requests use smaller first windows and parallel chunks.
- Library fetches go through the local proxy, eliminating CORS failures.
- The challenge detector no longer rejects large pages that merely contain a
  warning block.
- Version 1.1.0; the baked-in metadata key was removed from the renderer and
  injected server-side.

### Fixed

- The page fetch wrapper now signs same-origin absolute loopback URLs,
  restoring live TV and catalogue calls.
- Stale view state no longer survives a tab switch.

### Verified

- Android: 102-title Movies tab, posters loading through retry, live HLS
  channel playing, 480p episode playing, no CORS spam.
- Live TV: hundreds of channels parsed and played.
- APK: `versionCode=2`, one `classes.dex`, encrypted assets, R8 applied.
- Windows: installer launches, loads the catalogue and carries the new icon
  and version metadata.

## [1.0.0] — 2026-11-05

**The first standalone SuperBox release.** One brand, two apps, one library.

### Added

- A separate curated library with its own drawer group, hero, sections and
  infinity motif.
- Catalogue sheet reachable from the hero, the drawer and Me, naming every
  catalogue behind the library.
- Gold infinite-aura visual system: breathing logo glow, aura rings, an
  infinity watermark, source chips and a premium drawer card.
- Native playback for real MP4/HLS streams, with an ordered provider ladder
  that rotates past dead shells.
- Touch-first Android UI: five-tab navigation, search, details, seasons,
  episodes, quality/audio/speed sheets and rotation.
- Windows installer with a normal wizard and a freely chosen install folder or
  drive.

### Changed

- The extended library is branded SuperBox Vault everywhere; upstream brand
  names were removed from the shipped UI.
- The APK is signed with the SuperBox release key and verified before
  packaging.

### Verified

- Spotlight: 226 cards on Home; Movies 103, Series 115, Anime 26.
- Shared library: five rows and 104 cards on Home; 193 web-series titles; live
  TV with 17 groups and 200 channels.
- Detail, catalogue sheet and native playback tested on the reference emulator.
- APK signature and SHA-256 recorded in the release notes.

[1.4.0]: https://github.com/mohdziauddin2006-cloud/superbox/releases/tag/v1.4.0
[1.3.0]: https://github.com/mohdziauddin2006-cloud/superbox/releases/tag/v1.3.0
[1.2.0]: https://github.com/mohdziauddin2006-cloud/superbox/releases/tag/v1.2.0
[1.1.0]: https://github.com/mohdziauddin2006-cloud/superbox/releases/tag/v1.1.0
[1.0.0]: https://github.com/mohdziauddin2006-cloud/superbox/releases/tag/v1.0.0


## 1.4.1

- Living frosted-glass UI, animated hero slides, spaced metadata pills.
- Instant background VPN launch with real multi-country egress and live uptime.
- Frosted-glass in-app auto-updater with verified GitHub Releases backend.
- App-wide offline ONNX AI semantic search and reranking.
- Artwork fallbacks and full cross-check audit.
- Light/Dark mode and removable Continue Reading controls.

Assets:
- SuperBox-Setup-1.4.1.exe (248658572 bytes) SHA-256 11e10ba91af20541463af1dd64c6b5d4a2c7e817c4e9da6c125f1f4f26107083
- SuperBox-1.4.1.apk (302270911 bytes) SHA-256 4c5a8ad2ae4bb3dccdddf84d94e46cad83cd9476dbab8b47658ff0cd282c6f1f
