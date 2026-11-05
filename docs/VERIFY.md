# Release verification — v1.1.0

Everything below was checked on the artifacts in `dist/`. The Android build was
installed and exercised on the `WatchAnyBoxAVD` Android 14 emulator; the Windows
build was launched from `dist/win-unpacked`.

## Checksums

| Artifact | Size | SHA-256 |
|---|---:|---|
| `SuperBox-Setup-1.1.0.exe` | 121,460,102 B | `53BB7BAF06584E9777C54307AF34480FEFE2638EE76251C48C440269359C12CC` |
| `SuperBox-Portable-1.1.0.exe` | 110,292,945 B | `CEEA6FF4D7F0A9C7447F25A400313779A6349CF4E51B433938BEF390CAD14F19` |
| `SuperBox-1.1.0.apk` | 2,475,383 B | `B9E4CE69A264223F3EE13CDA456DB01C3C543A25E9FA04B8901A6FD32274D0F4` |

Verify on Windows:

```powershell
Get-FileHash .\SuperBox-Setup-1.1.0.exe -Algorithm SHA256
Get-FileHash .\SuperBox-Portable-1.1.0.exe -Algorithm SHA256
Get-FileHash .\SuperBox-1.1.0.apk -Algorithm SHA256
```

## Android signature and package

```
Signer #1 certificate DN: CN=SuperBox, OU=Mobile, O=SuperBox, L=Hyderabad, ST=Telangana, C=IN
Signer #1 certificate SHA-256 digest: 5a59f92f2526dbdd47b679510ac9ec1754aa479330f304b727997aafa2d82017
```

```powershell
apksigner verify --print-certs .\SuperBox-1.1.0.apk
aapt dump badging .\SuperBox-1.1.0.apk
```

```
package: name='com.superbox.mobile' versionCode='2' versionName='1.1.0'
sdkVersion:'23'
targetSdkVersion:'34'
application-label:'SuperBox'
```

The APK contains no native libraries, so the single universal build runs on
`armeabi-v7a`, `arm64-v8a`, `x86` and `x86_64`.

Package inspection:

- one `classes.dex`;
- no plain `.js` entries — only `app.js.enc`, `library.js.enc`,
  `libraries.js.enc`, `sources.js.enc`, `hls.min.js.enc` and
  `dash.all.min.js.enc`;
- R8 shrinking/optimization applied; `LocalServer` and `MainActivity` strings
  are obfuscated in the dex.

## What was tested

| Area | Result |
|---|---|
| Cold start | 1.39 s with the cached Home snapshot |
| Home | cached catalogue paints immediately, then refreshes |
| Movies tab | 102 titles, unified library rows, Live TV / 18+ / Sources chips |
| Posters | first-load failures retry and resolve without leaving initials |
| Library fetch | YouTube page parsed through `/page`; no CORS error spam |
| Token gating | `/page`, `/img`, `/stream` and `/tmdb` accept the injected token for both relative and absolute loopback URLs |
| MP4 episode | 480p stream started in ~9 s (was ~45 s before the window change) |
| HLS live TV | India playlist parsed (845 channels); 4 SIDES TV played and advanced |
| Detail / episodes | series detail, 43-episode grid and Play S1E1 worked |
| Sources sheet | 7 catalogue groups listed, 18+ row present |
| Back navigation | hardware Back and in-app Back return to the correct tab |
| Branding | no “SuperBox Vault” navigation, drawer group or hero remains |
| Windows installer | built with electron-builder 26.18.0, version metadata 1.1.0 |
| Windows portable | launches, catalogue loads, new infinity icon embedded |
| Icon | Android mipmaps and both EXEs carry `infinite icon.jpeg` artwork |

## Known limits

- Provider streams depend on host availability, region and network conditions.
- First screenshot/artwork loads can take several seconds while the disk cache
  warms; the retry handler fills them in automatically.
- Live HLS startup is segment-bound and took roughly 15 s on the test emulator.
- Provider subtitle URLs can expire or reject requests; subtitle support varies
  by title.
- The Android build is a pure-Java WebView shell, not a native ExoPlayer app.
  Hardware decoding support follows the device WebView.
- The Windows build targets x64. Windows 11 on ARM runs it through x64
  emulation.
