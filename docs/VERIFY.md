# Release verification — v1.3.0

Everything below was checked on the artifacts in `dist/`. The Windows Setup was
installed and launched headless; the APK was installed on the `WatchAnyBoxAVD`
Android 14 emulator and driven through its loopback BFF and UI.

## Checksums

| Artifact | Size | SHA-256 |
|---|---:|---|
| `SuperBox-Setup-1.3.0.exe` | 125,591,521 B | `A21067CCC181088F62A03538FD3E4840B07B8BCDD6EECF191D4E2428875AD778` |
| `SuperBox-1.3.0.apk` | 277,497,277 B | `1BB79E6230A9EEDB8DD54E6CFA5A9E29F1D85EAB764032AB607EADDA0E4C4D6B` |

Verify on Windows:

```powershell
Get-FileHash .\SuperBox-Setup-1.3.0.exe -Algorithm SHA256
Get-FileHash .\SuperBox-1.3.0.apk -Algorithm SHA256
```

## Android signature and package

```
Signer #1 certificate DN: CN=SuperBox, OU=Mobile, O=SuperBox, L=Hyderabad, ST=Telangana, C=IN
Signer #1 certificate SHA-256 digest: 5a59f92f2526dbdd47b679510ac9ec1754aa479330f304b727997aafa2d82017
```

```powershell
apksigner verify --verbose --print-certs .\SuperBox-1.3.0.apk
aapt2 dump badging .\SuperBox-1.3.0.apk
```

```
package: name='com.superbox.mobile' versionCode='4' versionName='1.3.0'
sdkVersion:'23'
targetSdkVersion:'34'
application-label:'SuperBox'
native-code: 'arm64-v8a' 'armeabi-v7a' 'x86' 'x86_64'
```

Signature schemes v1, v2 and v3 all verify. Package inspection:

- four ABIs with uncompressed native libraries, including the bundled
  `libusque.so` VPN engine per ABI;
- `assets/ffmpeg/ffmpeg-kit-full-gpl-6.0.LTS.aar` bundled as an on-device
  decoder archive;
- one `classes.dex`;
- no plain `.js` entries — only the AES-GCM `.js.enc` assets;
- R8 shrinking/optimization applied.

## Windows installer

```
ProductName    : SuperBox
ProductVersion : 1.3.0.0
FileVersion    : 1.3.0
Install path   : C:\Program Files\SuperBox
```

The installed executable was launched with `SB_HEADLESS=1`, audio muted at the
process level, and queried over CDP on port 9333.

## What was tested

| Area | Result |
|---|---|
| Windows install | Setup installed successfully; installed app reports 1.3.0 |
| Windows Shield | gate hidden, `warp=ON`, egress `IN` |
| Windows Moviebox | Spotlight hero, 50 cards, 16 rows; detail with episodes |
| Windows playback | `readyState=4`, 1152×480, muted, player closed cleanly |
| Windows Reading | 24 cards, 24 covers, 32 chapters, page rendered at 768×1024 |
| Windows WEBTOON | 30 cards, 30 covers, 10 chapters |
| Windows sources | 47 cards in 3 groups; iframe opens `netmirror.plus` |
| Android install | `adb install -r` succeeded on the Android 14 emulator |
| Android Shield | bundled usque starts, `ready egress=IN warp=true`, IPv6 anchor `2606:4700:103::2`; gate blocks the UI until then |
| Android Moviebox | `Daayra [Hindi]`, 853×480 decoder, 8,373 s, playing through `/stream` with the CDN on the direct split |
| Android Hentai.tv | offscreen challenge captured the signed r2 URL in ~4 s; 1,167 s, playing |
| Android Hentaicity | signed `.mp4.urlset/master.m3u8` playlist preserved; 1,416 s, playing through hls.js |
| Android Reading | 24 cards, 32 chapters, 768 px reader pages, 24 images loaded |
| Android sources | 47 cards, 3 groups, 4 filter chips |
| Android audio | emulator launched with `-no-audio`; every probe stayed silent |
| Media ceiling | no test stream ran longer than 9 seconds, then was force-stopped |
| APK signature | `apksigner verify` passes v1/v2/v3 |

## Pinned source coverage

`source.txt` contains 47 unique URLs after normalisation. The Sources hub has
47 cards: 23 movies/TV, 10 anime and 14 manga/manhwa. A normalised diff against
`source.txt` reports no missing and no extra entries.

## Known production limits

- **WARP is anycast.** A requested region selects an endpoint pool; it cannot
  guarantee the egress country. The status object always reports the actual
  egress.
- **Moviebox media CDN blocks WARP** with `427 Forbidden`. Catalogue, API and
  artwork stay behind the tunnel; media bytes use the scoped direct split.
- **Third-party availability:** Comick's API was down, ManhuaUS serves a JS
  verification page, and Asura relies on unscraped Astro data. Those sources
  open in the VPN-routed in-app browser.
- **External chapters:** MangaDex chapters that only expose an `externalUrl`
  show the publisher link instead of inventing pages.
