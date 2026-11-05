# Release verification — v1.0.0

Everything below was checked on the artifacts attached to the
[v1.0.0 release](https://github.com/mohdziauddin2006-cloud/superbox/releases/tag/v1.0.0).

## Checksums

| Artifact | Size | SHA-256 |
|---|---:|---|
| `SuperBox-Setup-1.0.0.exe` | 120,677,871 B | `1865CB030E1B8C3B207D03E6DD47D93DC80E23F6C68E7E3E71CE3F0BFCBD6F42` |
| `SuperBox-Portable-1.0.0.exe` | 109,649,353 B | `2A017D45C16E7DD6D5C921725B3B6827DD230B1EBED36FAC100DBFE0D1739716` |
| `SuperBox-1.0.0.apk` | 144,602 B | `A64E87A4668552FBBFFD3A26A8B50DCD6165C1E5E3728ECB7EF3D59C79971FF6` |

Verify on Windows:

```powershell
Get-FileHash .\SuperBox-Setup-1.0.0.exe -Algorithm SHA256
Get-FileHash .\SuperBox-Portable-1.0.0.exe -Algorithm SHA256
Get-FileHash .\SuperBox-1.0.0.apk -Algorithm SHA256
```

## Android signature

```
Signer #1 certificate DN: CN=SuperBox, OU=Mobile, O=SuperBox, L=Hyderabad, ST=Telangana, C=IN
Signer #1 certificate SHA-256 digest: 5a59f92f2526dbdd47b679510ac9ec1754aa479330f304b727997aafa2d82017
```

Re-check with the Android build-tools:

```powershell
apksigner verify --print-certs .\SuperBox-1.0.0.apk
aapt dump badging .\SuperBox-1.0.0.apk
```

```
package: name='com.superbox.mobile' versionCode='1' versionName='1.0.0'
sdkVersion:'23'
targetSdkVersion:'34'
application-label:'SuperBox'
```

The APK contains no native libraries, so it runs on every Android ABI.

## What was tested

| Area | Result |
|---|---|
| Spotlight Home | 226 cards, five bottom tabs |
| Movies / Series / Anime | 103 / 115 / 26 cards |
| Vault Home | hero + 5 rows, 104 cards, 18 posters painted |
| Vault sections | Web Series opens “SuperBox Vault / Web Series”; no bottom tab active |
| Vault drawer | 15 entries in 2 groups; scroll resets to the top |
| Library sources | opens from hero, drawer and Me; all source groups listed |
| Vault detail | title, metadata, Play now and Sources render |
| Playback | provider stream loaded 1920×1080, 1:26:29 runtime, position advanced |
| Branding | zero old brand strings in APK text assets |
| Windows installer | wizard, custom folder/drive, finish and launch verified |
| Windows app | catalogue, playback and settings verified |

The only remaining upstream hostname occurrence is an API/referer string in
code, never shown in the UI.

## Known limits

- Provider streams depend on host availability, region and network conditions.
- Provider subtitle URLs can expire or reject requests; subtitle support varies
  by title.
- First Vault loads take roughly 4–9 seconds on the test emulator; video start
  can take 16–46 seconds while the provider ladder resolves.
- The Windows build targets x64. Windows 11 on ARM runs it through x64
  emulation.
