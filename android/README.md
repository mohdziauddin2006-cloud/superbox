# SuperBox for Android

A single APK: the Spotlight catalogue plus the full **SuperBox Vault** library,
a native-format player, and an in-app web player for provider shells.

- **Package:** `com.superbox.mobile`
- **Version:** 1.0.0 (versionCode 1)
- **Android:** 6.0+ (API 23), target API 34
- **ABI:** universal — no native libraries
- **Permissions:** internet + network state only

## Build

You need JDK 17, Android SDK platform 34, build-tools 34.0.0 and Python 3.

```powershell
Copy-Item build.local.example.ps1 build.local.ps1
# edit build.local.ps1 with your keystore details
.\build.ps1
```

The APK is written to `..\dist\SuperBox-<version>.apk` and the script prints
its SHA-256. `build.local.ps1` and `superbox.keystore` are git-ignored — the
same keystore must be used for every update so Android can install in place.

The build is intentionally SDK-only: `aapt2` compiles the resources, `javac`
compiles the Java sources, `d8` produces `classes.dex`, then the APK is
zipaligned and signed with `apksigner`.

## Layout

```
assets/     UI, Spotlight bridge, Vault catalogue and scrapers
res/        launcher icon, strings and theme
src/        MainActivity, LocalServer and the native player overlay
tools/      add-dex.py (build helper)
```

`LocalServer.java` is a loopback-only HTTP bridge. It serves the packaged UI,
signs Spotlight API calls, proxies artwork and streams, and never binds beyond
`127.0.0.1`.
