# SuperBox v1.1.0

One library. Faster start. Reliable playback.

## Highlights

- **The Vault is gone.** Its catalogue, rows and sources now live inside the
  normal Library tabs. Movies, Series and Anime mix both catalogues, the chips
  filter the combined set, and search covers everything at once.
- **Playback that works.** MP4 plays natively, HLS and DASH use bundled engines
  with recovery and an ordered quality fallback chain. MP4 start time on the
  reference emulator dropped from ~45 s to ~9 s.
- **Fast start.** Home paints from a local snapshot in ~1.39 s, then refreshes.
  API, TMDB, page, image, HLS and DASH responses are cached on disk.
- **Artwork that arrives.** Poster cards retry transient image failures instead
  of staying stuck on their initials.
- **Quiet console.** Library fetches go through the local proxy, so the
  repeated YouTube/allorigins CORS failures are gone.
- **Hardened Android build.** Per-session localhost token, SSRF guards, R8,
  obfuscated first-party scripts and AES-256-GCM encrypted JS assets.
- **New icon.** The infinity mark is used for every Android mipmap and both
  Windows executables.

## Downloads

| Artifact | Size | SHA-256 |
|---|---:|---|
| `SuperBox-Setup-1.1.0.exe` | 121,460,102 B | `53bb7baf06584e9777c54307af34480fefe2638ee76251c48c440269359c12cc` |
| `SuperBox-Portable-1.1.0.exe` | 110,292,945 B | `ceea6ff4d7f0a9c7447f25a400313779a6349cf4e51b433938bef390cad14f19` |
| `SuperBox-1.1.0.apk` | 2,475,383 B | `b9e4ce69a264223f3ee13cda456db01c3c543a25e9fa04b8901a6fd32274d0f4` |

The APK is one universal build (`armeabi-v7a`, `arm64-v8a`, `x86`, `x86_64`),
signed with the existing SuperBox release key.

Full verification details: [VERIFY.md](VERIFY.md).
