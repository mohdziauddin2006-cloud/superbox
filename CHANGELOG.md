# Changelog

All notable changes to SuperBox are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

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
