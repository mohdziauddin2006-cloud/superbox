param(
    [string]$BuildTools = "34.0.0"
)

$ErrorActionPreference = "Continue"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$workspace = Split-Path -Parent $root
$sdk = $env:ANDROID_HOME
if (-not $sdk) { $sdk = "$env:LOCALAPPDATA\Android\Sdk" }
if (-not (Test-Path $sdk)) { throw "Android SDK not found. Set ANDROID_HOME." }

$bt = Join-Path $sdk "build-tools\$BuildTools"
if (-not (Test-Path $bt)) {
    $latest = Get-ChildItem (Join-Path $sdk "build-tools") -Directory |
        Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
    if (-not $latest) { throw "No Android build-tools installed." }
    $bt = $latest.FullName
}
$androidJar = Join-Path $sdk "platforms\android-34\android.jar"
if (-not (Test-Path $androidJar)) { throw "android-34 platform not found in the SDK." }

$aapt2 = Join-Path $bt "aapt2.exe"
$zipalign = Join-Path $bt "zipalign.exe"
$apksigner = Join-Path $bt "apksigner.bat"
$d8 = Join-Path $bt "d8.bat"
$aapt = Join-Path $bt "aapt.exe"

# Signing secrets live in build.local.ps1 (git-ignored) or the environment.
# Copy build.local.example.ps1 to build.local.ps1 and fill it in.
$local = Join-Path $root "build.local.ps1"
if (Test-Path $local) { . $local }

$keystore = if ($Keystore) { $Keystore } else { Join-Path $root "superbox.keystore" }
$alias = if ($Alias) { $Alias } else { "superbox" }
$storePass = if ($StorePass) { $StorePass } else { $env:SB_STORE_PASS }
$keyPass = if ($KeyPass) { $KeyPass } else { $env:SB_KEY_PASS }
if (-not $storePass -or -not $keyPass) {
    throw "Keystore password missing. Copy build.local.example.ps1 to build.local.ps1, or set SB_STORE_PASS / SB_KEY_PASS."
}

$manifest = Get-Content (Join-Path $root "AndroidManifest.xml") -Raw
$versionName = "1.0.0"
if ($manifest -match 'android:versionName="([^"]+)"') { $versionName = $Matches[1] }

$build = Join-Path $root "build"
$gen = Join-Path $build "gen"
$classes = Join-Path $build "classes"
$dexDir = Join-Path $build "dex"
$stagingAssets = Join-Path $build "assets"
$dist = Join-Path $workspace "dist"

$python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $python) { $python = (Get-Command py -ErrorAction SilentlyContinue).Source }
if (-not $python) { throw "Python 3 is required to add classes.dex." }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "Node.js is required to obfuscate and encrypt assets." }

if (Test-Path $build) { Remove-Item $build -Recurse -Force }
New-Item -ItemType Directory -Force -Path $gen, $classes, $dexDir, $dist | Out-Null

Write-Host "== stage + obfuscate + encrypt assets =="
& $node (Join-Path $workspace "tools\build-assets.mjs") `
    (Join-Path $root "assets") $stagingAssets `
    (Join-Path $root "src\com\superbox\mobile\BuildSecrets.java")
if ($LASTEXITCODE -ne 0) { throw "asset staging failed" }

Write-Host "== aapt2 compile =="
& $aapt2 compile --dir (Join-Path $root "res") -o (Join-Path $build "res.zip")
if ($LASTEXITCODE -ne 0) { throw "aapt2 compile failed" }

Write-Host "== aapt2 link =="
& $aapt2 link -o (Join-Path $build "base.apk") -I $androidJar `
    --manifest (Join-Path $root "AndroidManifest.xml") `
    -A $stagingAssets `
    --java $gen `
    (Join-Path $build "res.zip")
if ($LASTEXITCODE -ne 0) { throw "aapt2 link failed" }

Write-Host "== javac =="
$sources = @()
$sources += (Get-ChildItem (Join-Path $root "src") -Recurse -Filter *.java).FullName
$sources += (Get-ChildItem $gen -Recurse -Filter *.java).FullName
$webkitJar = Join-Path $root "libs\androidx-webkit-1.12.1.jar"
if (-not (Test-Path $webkitJar)) { throw "androidx.webkit jar missing: $webkitJar" }
& javac -source 8 -target 8 -Xlint:-options -encoding UTF-8 -bootclasspath $androidJar -cp $webkitJar -d $classes $sources
if ($LASTEXITCODE -ne 0) { throw "javac failed" }

Write-Host "== R8 (shrink + optimize + obfuscate) =="
$classFiles = (Get-ChildItem $classes -Recurse -Filter *.class).FullName
$r8Jar = Join-Path $bt "lib\d8.jar"
& java -cp $r8Jar com.android.tools.r8.R8 --release --min-api 23 `
    --lib $androidJar --output $dexDir `
    --pg-conf (Join-Path $root "proguard-rules.pro") $classFiles $webkitJar
if ($LASTEXITCODE -ne 0) { throw "R8 failed" }

Write-Host "== add classes.dex =="
& $python (Join-Path $root "tools\add-dex.py") (Join-Path $build "base.apk") (Join-Path $dexDir "classes.dex")
if ($LASTEXITCODE -ne 0) { throw "adding classes.dex failed" }

# Universal decoder pack: every ABI's FFmpeg libraries ride in the APK
# uncompressed, and the complete AAR stays on device as a fallback asset.
# This is what makes the universal build a genuinely self-contained fat APK.
Write-Host "== bundle FFmpeg native decoders =="
$ffAar = Join-Path $root "libs\ffmpeg-kit-full-gpl-6.0.LTS.aar"
if (-not (Test-Path $ffAar)) { throw "FFmpeg decoder pack missing: $ffAar" }
& $python (Join-Path $root "tools\add-native-libs.py") (Join-Path $build "base.apk") $ffAar (Join-Path $root "libs\vpn")
if ($LASTEXITCODE -ne 0) { throw "bundling FFmpeg native libraries failed" }

Write-Host "== zipalign =="
& $zipalign -f -p 4 (Join-Path $build "base.apk") (Join-Path $build "aligned.apk")
if ($LASTEXITCODE -ne 0) { throw "zipalign failed" }

if (-not (Test-Path $keystore)) {
    Write-Host "== generate keystore =="
    & keytool -genkeypair -v -keystore $keystore -alias $alias `
        -keyalg RSA -keysize 2048 -validity 10000 `
        -storepass $storePass -keypass $keyPass `
        -dname "CN=SuperBox, OU=Mobile, O=SuperBox, L=Hyderabad, S=Telangana, C=IN"
    if ($LASTEXITCODE -ne 0) { throw "keytool failed" }
}

$outApk = Join-Path $dist "SuperBox-$versionName.apk"
if (Test-Path $outApk) { Remove-Item $outApk -Force }

Write-Host "== apksigner =="
& $apksigner sign --ks $keystore --ks-pass "pass:$storePass" --key-pass "pass:$keyPass" `
    --out $outApk (Join-Path $build "aligned.apk")
if ($LASTEXITCODE -ne 0) { throw "apksigner sign failed" }

Write-Host "== verify =="
& $apksigner verify --print-certs $outApk
if ($LASTEXITCODE -ne 0) { throw "apksigner verify failed" }

& $aapt dump badging $outApk
if ($LASTEXITCODE -ne 0) { throw "aapt dump failed" }

$item = Get-Item $outApk
Write-Host ""
Write-Host ("APK: {0}" -f $item.FullName)
Write-Host ("SIZE: {0:N0} bytes ({1:N2} MB)" -f $item.Length, ($item.Length / 1MB))
Write-Host ("SHA256: {0}" -f (Get-FileHash $outApk -Algorithm SHA256).Hash)
