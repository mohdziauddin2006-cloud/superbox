# Release verification — v1.2.0

Everything below was checked on the artifacts in `dist/`. The Windows Setup was
installed silently and launched headless; the APK was installed on the
`WatchAnyBoxAVD` Android 14 emulator and driven through Chrome DevTools.

## Checksums

| Artifact | Size | SHA-256 |
|---|---:|---|
| `SuperBox-Setup-1.2.0.exe` | 121,464,282 B | `95FA0DB168BC53E2AA29F1241179A7BE691CACAD4D04A199E6CA045230B77209` |
| `SuperBox-1.2.0.apk` | 227,029,978 B | `43E4E24C583B558EA53841D7FC7F2FD309E0F9AD85A40875C87CDA0338CE0D49` |

Verify on Windows:

```powershell
Get-FileHash .\SuperBox-Setup-1.2.0.exe -Algorithm SHA256
Get-FileHash .\SuperBox-1.2.0.apk -Algorithm SHA256
```

## Android signature and package

```
Signer #1 certificate DN: CN=SuperBox, OU=Mobile, O=SuperBox, L=Hyderabad, ST=Telangana, C=IN
Signer #1 certificate SHA-256 digest: 5a59f92f2526dbdd47b679510ac9ec1754aa479330f304b727997aafa2d82017
```

```powershell
apksigner verify --verbose --print-certs .\SuperBox-1.2.0.apk
aapt2 dump badging .\SuperBox-1.2.0.apk
```

```
package: name='com.superbox.mobile' versionCode='3' versionName='1.2.0'
sdkVersion:'23'
targetSdkVersion:'34'
application-label:'SuperBox'
native-code: 'arm64-v8a' 'armeabi-v7a' 'x86' 'x86_64'
```

Signature schemes v1, v2 and v3 all verify.

Package inspection:

- 48 uncompressed `lib/<abi>/*.so` entries across the four ABIs;
- `assets/ffmpeg/ffmpeg-kit-full-gpl-6.0.LTS.aar` (73,596,363 B) bundled as an
  on-device decoder archive;
- one `classes.dex`;
- no plain `.js` entries — only the six AES-GCM `.js.enc` assets;
- R8 shrinking/optimization applied.

## Windows installer

```
ProductName    : SuperBox
ProductVersion : 1.2.0.0
FileVersion    : 1.2.0
Install path   : C:\Program Files\SuperBox
```

The installed executable was launched with `SB_HEADLESS=1`, audio muted at the
process level, and queried over CDP on port 9333.

## What was tested

| Area | Result |
|---|---|
| Windows install | silent Setup install completed; installed app reports 1.2.0 |
| Windows cold paint | 276 ms to first cards, 104 cards rendered |
| Windows lazy rows | first four eager, remaining rows hydrate on scroll |
| Windows playback | Rule34, MMS/JAV, AWS MP4, Hentai and AI lanes started muted; all torn down ≤1 s |
| Android install | `adb install -r` succeeded on the Android 14 emulator |
| Android cold start | launched in 4.5 s, home catalogue and hero rendered |
| Android artwork | initials placeholder first, then all visible posters resolved as the disk cache warmed |
| Android MP4 | native player advanced 0 → 1.0 s → 2.5 s, then stopped |
| Android HLS | native player advanced 0 → 0.9 s → 2.8 s, then stopped |
| Android audio | emulator launched with `-no-audio`; every probe stayed silent |
| Media ceiling | no test stream ran longer than 10 seconds |
| APK signature | `apksigner verify` passes v1/v2/v3 |
| APK contents | four ABIs, 48 native libraries, decoder archive, one dex |

## Known limits

- Provider streams depend on host availability, region and network conditions.
  A source that refuses connections cannot be made playable by the app.
- Android runtime testing used a single emulator profile; physical-device
  hardware decoding follows the installed WebView.
- First artwork loads can still take several seconds while the disk cache warms;
  the retry chain fills them in automatically.
- Live HLS startup is segment-bound and depends on the playlist host.
- Provider subtitle URLs can expire or reject requests; subtitle support varies
  by title.
- The Android build is a pure-Java WebView shell, not a native ExoPlayer app.
- The Windows build targets x64. Windows 11 on ARM runs it through x64
  emulation.
