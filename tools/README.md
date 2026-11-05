# SuperBox dev tools

Small, dependency-free CDP helpers used to verify the Android build on an
emulator. They run inside the app's WebView, so they see the same DOM the user
sees.

## Attach to the running app

```powershell
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
$pid = (& $adb shell pidof com.superbox.mobile).Trim()
& $adb forward tcp:9223 localabstract:webview_devtools_remote_$pid
```

Recreate the forward after every reinstall or relaunch.

## Run a check

```powershell
node tools/cdp-run.mjs 9223 tools/smoke-spotlight.js
node tools/cdp-run.mjs 9223 tools/smoke-playback.js
node tools/inspect-provider-video.mjs 9223
```

| Script | What it proves |
|---|---|
| `smoke-spotlight.js` | Home, the three library tabs and Me load, with card counts and no old brand text |
| `smoke-playback.js` | Opens a library title and starts the provider or native player |
| `inspect-provider-video.mjs` | Reads the provider overlay's `<video>` state (resolution, duration, playback) |

`cdp-run.mjs` evaluates any JS file in the WebView; `cdp-shot.mjs` captures a
PNG from any Chromium/Electron CDP target.

These are development checks, not part of the shipped APK.
