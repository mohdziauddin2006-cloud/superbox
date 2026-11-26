<div align="center">
  <img src="docs/hero-1.4.svg" alt="SuperBox 1.4.1" width="640">
  <h1>CHANGELOG</h1>
  <p><b>One box. Infinite library.</b></p>
  <p>
    <img alt="Version 1.4.1" src="https://img.shields.io/badge/release-v1.4.1-FFC105?style=flat-square&labelColor=0B0B0F">
    <img alt="Offline ONNX AI" src="https://img.shields.io/badge/AI-offline%20ONNX-FFC105?style=flat-square&labelColor=0B0B0F">
    <img alt="Verified relay VPN" src="https://img.shields.io/badge/VPN-verified%20relay-FFC105?style=flat-square&labelColor=0B0B0F">
    <img alt="Zero ads" src="https://img.shields.io/badge/ads-zero-FFC105?style=flat-square&labelColor=0B0B0F">
  </p>
</div>

All notable changes to SuperBox are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [1.4.1] - 2026-11-26

**The routing release.** The VPN now selects real exit countries instead of
relabelling one anycast tunnel. The updater, glass interface and Android
transport are finished in the same build.

### Added

- **Verified relay routing.** Public SOCKS5 and HTTP relays are discovered per
  country, tested concurrently, and accepted only when the Cloudflare trace
  endpoint reports the expected country and a second TLS endpoint reports the
  same egress IP. Relays that fail the second check are rejected.
- **Ten countries.** United Kingdom, United States, Japan, Germany, Australia,
  Singapore, Canada, Netherlands, France and India, each with its own relay
  pool and cached candidates.
- **Truthful connection status.** Verified egress IP, country, city, relay
  address and a ticking `HH:MM:SS` uptime. A watchdog rotates to another
  verified relay when the active one stops answering.
- **Desktop transport.** Chromium session proxy rules plus a global `undici`
  dispatcher. Loopback stays direct. Turning the VPN off clears both.
- **Android transport.** `VpnManager` performs discovery, verification, cache
  and failover. `LocalServer` exposes a loopback CONNECT tunnel for the WebView
  and forwards absolute-URI requests through the active relay.
- **WARP fallback.** Cloudflare WARP is now labelled **Fastest / Local Shield
  (WARP)** and is used only when relay discovery has no healthy candidate.
- **Real updater.** `window.SB_UPDATER`, the update modal, streamed download,
  progress reporting, SHA-256 verification and a re-check before launch.
- **App-wide offline search.** The bundled ONNX engine answers semantic search
  from Home and every scoped search bar, with safe and 18+ stores kept apart.
- **Poster fallback chain.** Each poster tries its origin, the local image
  proxy, then a public resizer. A failed CDN no longer leaves a blank card.
- **Episode ranges.** `1–50`, `51–100`, `101+` tabs generated from the real
  season total, with the range preserved across re-renders.
- **Glass interface.** Frosted panels, animated hero slides, spring motion and
  persisted light and dark themes.
- **Instant home.** The UI paints immediately while the VPN connects in the
  background.

### Changed

- The VPN panel reports the actual route. Relay mode names the verified country;
  WARP mode does not promise a country it cannot prove.
- Rapid country changes cancel the previous scan. The newest request wins, and a
  manual OFF is never overwritten by a late scan result.
- Light theme text tokens were darkened for contrast on home, detail, settings
  and VPN surfaces. Gold-on-dark accent text was replaced where it fell below
  AA.
- The updater downloads to a temporary folder and only exposes Install after
  the checksum matches.
- Episode range switches reset the list instead of appending duplicates.

### Fixed

- Chromium proxy rules now use `socks5://host:port`. The old `socks5=host:port`
  form was ignored silently and leaked direct traffic.
- MITM proxies are rejected by the second-host egress comparison.
- Poster failures recover through the local proxy and resizer instead of
  showing a permanent placeholder.
- Safe search no longer returns documents from the isolated 18+ store. A test
  document written to the isolated index was deduplicated on re-index and never
  appeared in safe results.
- Updater checksum mismatches abort the download with the expected and actual
  digests, and leave the installed version untouched.
- Light-theme VPN status rows and brand text now meet AA contrast.

### Security

- Adult catalogue identifiers, endpoints and vectors remain outside the public
  shell, public search and safe index.
- The age gate is the only route into adult reading. Deep search and the 18+
  video lane reuse the same verification.
- Android privileged routes still require the per-session token, and every
  first-party `.js` asset remains AES-256-GCM ciphertext at rest.
- Relay verification compares two independent HTTPS endpoints before a proxy is
  handed to Chromium or the Android tunnel.

### Verified

- Windows, packaged build: AI `mode=onnx`, `Xenova/all-MiniLM-L6-v2`, safe index
  762 documents, isolated index 0.
- Semantic search: warm queries 9–19 ms; similar section 16 unique cards in
  about 112 ms; isolated test item absent from safe search.
- VPN, desktop: US relay egress `US` at `ATL`; UK relay egress `GB` in London;
  Japan relay egress `JP` at `NRT`; Chromium trace IP matched the panel IP;
  uptime advanced from `00:00:02` to `00:00:06` and continued ticking.
- VPN, packaged build: GB relay connected with matching egress; OFF returned
  Chromium to the direct `IN` / `BOM` route; WARP fallback reported `IN` / `BOM`.
- Updater: valid `SHA256SUMS.txt` downloaded and verified; a wrong expected hash
  was rejected with a mismatch error; modal and progress elements present.
- Posters: 104 cards, 104 poster elements, 0 broken; a deliberately missing TMDB
  image recovered through the fallback chain.
- Episodes: 137-episode demo produced `1–50`, `51–100`, `101–137`; the last tab
  showed episodes 101–137 with no duplicates.
- Contrast: zero real failures on home, detail, settings and VPN surfaces in
  both themes. The active Safe pill was confirmed as dark text over its separate
  green thumb, not a failure.
- Motion: hero Ken Burns, glass blur and spring transitions present; reduced
  motion collapses durations.
- JavaScript: `node --check` passes for `main.js`, `preload.js`, `renderer.js`,
  `libraries.js`, `relay.js` and `vpn.js`. Java sources compile with `javac`.
- APK: universal, `versionCode=6`, `versionName=1.4.1`, four ABIs, 52 native
  libraries, ONNX model and `infinite icon.jpeg` present, signature verified.

### Artifacts

| File | Bytes | SHA-256 |
|---|---:|---|
| `SuperBox-Setup-1.4.1.exe` | 248,664,675 | `D72EFC55CF2E9F40FDD4AB8F683DC816DF4C29F57147E61BB446C7331BCF8CFF` |
| `SuperBox-1.4.1.apk` | 302,262,719 | `14246D09DC9C5A6080525B614D895172EB5DBBC941ED6CDE36576D7D1ABE92D8` |

## [1.4.0] - 2026-11-24

**The intelligence release.** Recommendations moved on-device, the reader gained
a full HUD, every catalogue shipped behind one private shell, and the VPN became
a control panel instead of a status light.

### Added

- Offline q8 `all-MiniLM-L6-v2` ONNX model, tokenizer and runtime bundled with
  both apps. Loading uses `local_files_only: true`.
- 384-dimensional semantic matching with batched candidate embedding, cached
  document vectors and 12–16 similar previews with match pills.
- Independent safe and adult vector partitions, with the safe index rejecting
  adult documents.
- Reader HUD with paged, vertical and continuous modes, a chapter drawer,
  progress, chapter jump and keyboard or swipe input.
- Strict language filtering that omits chapters without a hosted page.
- Episode range tabs (`1–50`, `51–100`, `101+`) and a season selector.
- Non-blocking metadata fallback when the primary service is slow.
- Scoped search on every surface, with deep search behind the age gate.
- VPN panel with status chip, pulse ring, power copy, manual ON/OFF, latency,
  Auto-Region and searchable region cards.
- Native adapters, detail pages, chapter lists and readers for the complete
  reading catalogue set.
- Private 18+ reading vault and a separate 18+ video lane, both age-gated.
- Desktop and Android parity for the merged AI, reader and search layers.

### Changed

- The AI backend is part of both apps: one renderer state, one adult mode and
  one scoped search path.
- Candidate embedding runs in batches of 16 instead of one pass per title.
- Android serves `.mjs` as JavaScript and `.wasm` as `application/wasm`, and
  accepts model assets up to 40 MB.
- Reader page caches, covers and chapter lists are scoped to the active
  catalogue and language.
- Version 1.4.0; APK `versionCode=5`.

### Fixed

- `undici` and `TLSSocket` failures log once and fail the request instead of
  raising a process-level crash dialog.
- Every outbound fetch has a timeout, retry budget and stream error handler.
- Late AI responses are discarded when the seed changes.
- Episode rows no longer duplicate when a range tab is reselected.
- Reader mode changes preserve the current page.
- The VPN chip reports manual OFF and direct mode correctly.
- A failed ONNX load falls back to TF-IDF without disabling recommendations.
- Mobile AI assets decrypt before use, so the bundled runtime and model load
  from the encrypted asset store.

## [1.3.0] - 2026-11-12

**The everywhere release.** An embedded open-source VPN, restored playback on
both platforms, every catalogue wired, and a native reading room.

### Added

- Cloudflare WARP over MASQUE, bundled with both apps, with anonymous
  registration and a gate that stays closed until the tunnel is healthy.
- 13 region profiles with 12 endpoint profiles each, rotated for redundancy.
- Desktop transport: hidden local proxy, `undici` agent and Chromium proxy
  configuration, with loopback bypassed.
- Android transport: bundled native core per ABI, loopback upstream proxy and
  WebView proxy routing.
- Spotlight hero, front-page rows, detail pages, seasons, episodes and audio
  tracks on both platforms.
- Media proxy with a small first window, larger follow-ups, parallel range
  workers and a scoped direct path for the CDN that rejects VPN egress.
- Searchable internal catalogue directory with native rows where an API exists
  and an in-app shell everywhere else.
- Reading room with public catalogue APIs, genre and age filters, cached covers
  and pages, native readers and an external-chapter fallback card.
- Language, format and genre filters with request sequencing and cancellation.
- IPv6-first transport with an IPv4 fallback ladder.
- Signed-URL capture for players that mint a verification token.
- Universal APK with four ABIs and `versionCode=4`.

### Changed

- Auto-region is preference-only while the tunnel is healthy; a healthy tunnel
  is never torn down mid-session.
- VPN stop and restart wait for port release on both platforms.
- Covers are rewritten to the working image host, learned once and cached.
- Catalogue requests retry once to survive rate limits.

### Fixed

- Signed media URLs are used unescaped, and the media route returns real
  `206 video/mp4` windows instead of anti-bot HTML.
- Retry bookkeeping and stale play payloads.
- Image cache rejects anti-bot HTML by checking magic bytes.
- External-only chapters no longer open a blank reader.
- Quality rows no longer repeat titles or show model and category tiles, and
  play the highest signed rendition.
- Signed HLS URLs are preserved end to end.
- Home shelves tag every descriptor with its resolver, so no row is empty.
- The signed verification URL is captured and played when the media CDN rejects
  the platform TLS fingerprint.

## [1.2.0] - 2026-11-09

**The hardening release.** Faster cold starts, self-healing artwork, a universal
APK and a playback ladder that keeps trying until a source plays.

### Added

- Universal fat APK with every ABI plus a bundled FFmpeg decoder archive stored
  uncompressed for zero-copy loading.
- Stale-while-revalidate row cache: shelves paint from local storage first and
  refresh silently.
- Viewport-driven row hydration, with the first rows eager and the rest loading
  shortly before they scroll into view.
- Three-tier artwork fallback: local cache, origin, then image resizer.
- Native video error handling, load watchdogs and a fallback-to-embed-to-page
  handoff when a direct stream never starts.
- Desktop stall watchdog that rotates sources only after zero progress and
  cleans media listeners between sources.
- Headless verification mode with process-level audio mute, a hidden window and
  a debugging port.

### Changed

- Desktop releases are NSIS-only; portable and split builds are gone.
- Signed-file extraction uses a fast path, a resolver cache and reuse with
  automatic re-signing on failure.
- Episode requests carry a timeout and purge cached URLs on gateway errors.
- Version 1.2.0; APK `versionCode=3`.

### Fixed

- Galleries and adult lanes that never resolved now race the backend route
  against the client parser.
- Infinite loading shelves: every row has a ceiling and paints cache first.
- Memory and listener leaks when switching sources.
- Dead-image replay and stuck initial placeholders.

## [1.1.0] - 2026-11-05

**The unification release.** One library, faster startup, reliable artwork,
working HLS/DASH/MP4 playback and a hardened Android build.

### Added

- Unified library layer: Movies, Series and Anime render extra-library rows
  inline, with filter chips and combined search.
- Bundled HLS and DASH engines with lazy loading, media-error recovery and an
  ordered quality fallback chain.
- Disk caches for API JSON, metadata, proxied pages, images and manifests.
- Per-session localhost token. Privileged endpoints reject requests without it,
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

- The page fetch wrapper signs same-origin absolute loopback URLs, restoring
  live TV and catalogue calls.
- Stale view state no longer survives a tab switch.

## [1.0.0] - 2026-11-05

**The first standalone SuperBox release.** One brand, two apps, one library.

### Added

- A separate curated library with its own drawer group, hero, sections and
  infinity motif.
- Catalogue sheet reachable from the hero, the drawer and Me, naming every
  catalogue behind the library.
- Gold infinite-aura visual system: breathing logo glow, aura rings, an
  infinity watermark, source chips and a drawer card.
- Native playback for MP4 and HLS streams, with an ordered provider ladder that
  rotates past dead shells.
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

[1.4.1]: https://github.com/mohdziauddin2006-cloud/superbox/releases/tag/v1.4.1
[1.4.0]: https://github.com/mohdziauddin2006-cloud/superbox/releases/tag/v1.4.0
[1.3.0]: https://github.com/mohdziauddin2006-cloud/superbox/releases/tag/v1.3.0
[1.2.0]: https://github.com/mohdziauddin2006-cloud/superbox/releases/tag/v1.2.0
[1.1.0]: https://github.com/mohdziauddin2006-cloud/superbox/releases/tag/v1.1.0
[1.0.0]: https://github.com/mohdziauddin2006-cloud/superbox/releases/tag/v1.0.0
[1.2.0]: https://github.com/mohdziauddin2006-cloud/superbox/releases/tag/v1.2.0
[1.1.0]: https://github.com/mohdziauddin2006-cloud/superbox/releases/tag/v1.1.0
[1.0.0]: https://github.com/mohdziauddin2006-cloud/superbox/releases/tag/v1.0.0
