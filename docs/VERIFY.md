# Release verification — v1.4.0

Everything below was checked on the artifacts attached to the v1.4.0 release.
Windows ran headless with audio muted; Android was verified at the package,
signature and asset level.

## Checksums

| Artifact | Size | SHA-256 |
|---|---:|---|
| `SuperBox-Setup-1.4.0.exe` | 248,648,081 B | `4CEF93A4A7C3693529C957FE9A3A33BDCB9F505ED09FE82564C5E390420FF955` |
| `SuperBox-1.4.0.apk` | 302,201,211 B | `3003157DE51DBAD052433B70AE5023FE05C89521A4CAEAA617231451A9D1EDD4` |

Verify on Windows:

```powershell
Get-FileHash .\SuperBox-Setup-1.4.0.exe -Algorithm SHA256
Get-FileHash .\SuperBox-1.4.0.apk -Algorithm SHA256
```

## Windows installer

```
ProductName    : SuperBox
ProductVersion : 1.4.0.0
FileVersion    : 1.4.0
Install path   : C:\Program Files\SuperBox
```

The Setup ran silently, installed successfully and was uninstalled cleanly.
The installed executable was launched with `SB_HEADLESS=1`, audio muted at the
process level, and queried over CDP on port 9333.

- First paint: 259 ms.
- First paint content: 77 cards across 5 rows.
- After 3 seconds: 103 cards, every row loaded.
- Packaged `app.asar` version: 1.4.0.

## Offline AI

The installed build loaded the external model from `resources/models` and
reported:

```json
{"ok":true,"mode":"onnx","model":"Xenova/all-MiniLM-L6-v2","partitions":{"safe":123,"isolated":0}}
```

- 384-dimensional embeddings.
- Safe and isolated vector partitions are separate.
- The isolated partition stays empty until the 18+ vault is active.
- Warm similarity queries complete in about 10 ms on Windows.

The Android package contains the same q8 model, tokenizer and browser ONNX
runtime under `assets/ai/`. A hidden Chromium harness loaded the runtime from
the app's loopback origin in 907 ms, produced 384-dimensional vectors, and
returned its first recommendation pass in 151 ms and a warm pass in 19 ms.

## Media ceiling

A local 640×360 H.264/AAC clip was played through the packaged Windows build
with `SB_HEADLESS=1` and process-level audio mute:

```
readyState=4  currentTime=2.96  duration=5.00  640×360  muted=true
elapsed=3.19 s
```

The element was paused and torn down immediately. No verification stream ran
longer than ten seconds, and no window or audio output was visible.

## Android signature and package

```
Signer #1 certificate DN: CN=SuperBox, OU=Mobile, O=SuperBox, L=Hyderabad, ST=Telangana, C=IN
Signer #1 certificate SHA-256 digest: 5a59f92f2526dbdd47b679510ac9ec1754aa479330f304b727997aafa2d82017
```

```powershell
apksigner verify --verbose --print-certs .\SuperBox-1.4.0.apk
aapt2 dump badging .\SuperBox-1.4.0.apk
```

```
package: name='com.superbox.mobile' versionCode='5' versionName='1.4.0'
sdkVersion:'23'
targetSdkVersion:'34'
application-label:'SuperBox'
native-code: 'arm64-v8a' 'armeabi-v7a' 'x86' 'x86_64'
```

Signature schemes v1, v2 and v3 verify. Package inspection:

- four ABIs with uncompressed native libraries, including the bundled VPN core
  per ABI;
- 52 native libraries plus the FFmpeg decoder archive;
- `assets/ai/models/Xenova/all-MiniLM-L6-v2/` with the q8 ONNX model,
  tokenizer and vocabulary;
- the asyncify ONNX runtime and browser bundle under `assets/ai/`;
- `assets/infinite icon.jpeg`;
- one `classes.dex`;
- no plain `.js` entries — only the AES-GCM `.js.enc` assets;
- R8 shrinking, optimization and obfuscation applied.

## Surface checks

| Area | Result |
|---|---|
| JavaScript syntax | every desktop and Android bundle passes `node --check` |
| Android Java | server, activity, VPN and player sources compile |
| Reader HUD | modes, chapter drawer, keyboard and swipe handlers present |
| Scoped search | inputs and clear controls present on every search surface |
| Deep search | opens through the age gate |
| Episode ranges | `1–50`, `51–100`, `101+` generated from season totals |
| VPN panel | power control, pulse ring, latency badge, Auto-Region, region search |
| Vector isolation | safe index populated, isolated index empty until 18+ is active |
| Catalogue adapters | ordered pages and chapter lists returned within the cap |
| 18+ isolation | standard Reading and Kids contain zero adult items |

## Known production limits

- **WARP is anycast.** A requested region selects an endpoint pool; it cannot
  guarantee the egress country. The status object reports the actual egress
  when known.
- **One media CDN blocks WARP.** Its catalogue, metadata and artwork stay
  behind the tunnel; signed media bytes use a scoped direct path. The exception
  does not apply to any other host.
- **Third-party availability:** catalogues can add verification pages, rate
  limits or regional blocks at any time. Native adapters fall back to the
  VPN-routed shell, and a failed request never crashes the app.
- **External chapters:** chapters that only expose a publisher link show that
  link instead of inventing page images.
- **Windows code signing:** the Android APK is signed; the Windows installer is
  not signed with a paid certificate, so SmartScreen may ask for confirmation.
