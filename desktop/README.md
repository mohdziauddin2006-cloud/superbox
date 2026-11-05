# SuperBox for Windows

The desktop edition: Electron shell, local proxy, native playback, and the full
Spotlight + unified library catalogue.

- **Targets:** Windows 10/11 x64 — NSIS installer and portable EXE
- **Electron:** 44.7.0
- **Installer:** user-mode by default, any install folder/drive, no admin required

## Run from source

```powershell
npm install
npm start
```

## Build installers

```powershell
npm run dist
```

`electron-builder` writes `SuperBox-Setup-<version>.exe` and
`SuperBox-Portable-<version>.exe` to `..\dist`.

## Layout

```
main.js       Electron main process and window
preload.js    the narrow bridge exposed to the renderer
renderer.js   the app UI and catalogue views
srv2.js       loopback proxy, catalogue resolver and stream extractor
sources.js    library catalogue data
libraries.js  library scrapers
styles.css    desktop visual system
hls.min.js    vendored HLS playback support
```

The proxy listens only on `127.0.0.1` (ports 46901–46903) and is torn down
with the window.
