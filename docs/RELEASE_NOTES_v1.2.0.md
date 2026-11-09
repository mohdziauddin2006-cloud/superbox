# SuperBox 1.2.0 — the hardening release

**Released:** 9 November 2026

SuperBox 1.2.0 is about making the existing library feel instant and making
playback finish what it starts. Every shelf now paints from cache first, loads
the rest lazily, and every image has a fallback. The Android build is now a
single 227 MB universal APK with all four ABIs and a bundled decoder archive.

## Downloads

| Build | Size | SHA-256 |
|---|---:|---|
| `SuperBox-Setup-1.2.0.exe` | 121,464,282 B | `95FA0DB168BC53E2AA29F1241179A7BE691CACAD4D04A199E6CA045230B77209` |
| `SuperBox-1.2.0.apk` | 227,029,978 B | `43E4E24C583B558EA53841D7FC7F2FD309E0F9AD85A40875C87CDA0338CE0D49` |

The portable Windows build is retired. The Setup wizard remains the only
desktop package.

## Highlights

### Fast, lazy, cached

- Home paints from a localStorage snapshot before any network call.
- Shared `IntersectionObserver` hydration: four eager rows, then 700 px of
  lead time for the rest.
- `sb.rows.v2` / `sb.desktop.rows.v2` caches use stale-while-revalidate, so a
  returning user sees the previous catalogue instantly.
- Hover-intent prefetch warms episode and 18+ detail pages on desktop.

### Artwork that heals

Each image walks a three-tier chain: local `/img` cache, the origin, then
`images.weserv.nl`. Failed `<img>` elements are removed only after the chain is
exhausted, so a dead CDN no longer leaves rows spinning forever.

### Playback that keeps trying

- Android: native `video.onerror`, an 18 s no-progress watchdog and a 45 s
  absolute cap; a failed direct stream hands off to `fallback`, then `embed`,
  then the provider page.
- Desktop: the player rotates sources after 15 s without progress (45 s hard
  cap), and media listeners are removed between sources.
- HLS recovers media and network errors before rotating; DASH resets once
  before rotating.
- Eporner uses an embed-only fast path, a 4-minute resolver cache and
  15-minute signed-file reuse; `/ep` has a 9 s timeout and purges dead cache
  entries on 502.

### Fat Android package

The APK is deliberately large:

- `arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64`;
- 48 uncompressed native libraries for zero-copy loading;
- `ffmpeg-kit-full-gpl-6.0.LTS.aar` (73.6 MB) stored as an on-device decoder
  archive.

One file covers phones, tablets, emulators and x86 devices.

## Verified

- Windows Setup installed and launched; version 1.2.0, first cards in 276 ms,
  104 cards on screen.
- Android APK installed on the Android 14 emulator; cold launch 4.5 s.
- Native MP4 advanced 0 → 1.0 s → 2.5 s; native HLS advanced 0 → 0.9 s → 2.8 s;
  both muted and stopped within the 10-second test ceiling.
- Desktop Rule34, MMS/JAV, AWS MP4, Hentai and AI lanes started muted and were
  torn down within one second.
- APK signature verifies with v1, v2 and v3 schemes; `versionCode=3`,
  `versionName=1.2.0`.

Full details and limits: [VERIFY.md](VERIFY.md).

## Upgrade notes

- Windows: run the Setup over an existing install; settings are preserved.
- Android: the APK is signed with the same certificate, so it upgrades in
  place. Allow ~250 MB of free storage during installation.
- If a provider host is down, the player will exhaust its ladder and open the
  provider page rather than hanging on a spinner.
