param(
    [string]$Apk = "dist\SuperBox-1.2.0.apk",
    [int]$BootTimeout = 240
)
$ErrorActionPreference = "Continue"
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { "$env:LOCALAPPDATA\Android\Sdk" }
$adb = Join-Path $sdk "platform-tools\adb.exe"
if (-not (Test-Path $adb)) { throw "adb not found" }

& $adb wait-for-device
$deadline = (Get-Date).AddSeconds($BootTimeout)
do {
    $booted = (& $adb shell getprop sys.boot_completed 2>$null) -join ""
    if ($booted -match "1") { break }
    Start-Sleep -Seconds 3
} while ((Get-Date) -lt $deadline)
if (-not $booted -match "1") { throw "Emulator did not boot within $BootTimeout s" }
Write-Output "BOOT_OK"

& $adb install -r $Apk 2>&1 | Select-Object -Last 2
& $adb shell am force-stop com.superbox.mobile
& $adb logcat -c
& $adb shell am start -W -n com.superbox.mobile/.MainActivity 2>&1 | Select-Object -First 8
Start-Sleep -Seconds 18

$appPid = (& $adb shell pidof com.superbox.mobile 2>$null) -join ""
Write-Output "APP_PID=$appPid"
$errs = & $adb logcat -d -v brief "*:E" 2>$null | Select-String -Pattern "FATAL|AndroidRuntime|superbox" | Select-Object -First 15
if ($errs) { Write-Output "=== ERRORS ==="; $errs | ForEach-Object { $_.ToString() } } else { Write-Output "NO_ERRORS" }
$web = & $adb logcat -d -v brief 2>$null | Select-String -Pattern "chromium|WebView|LocalServer" | Select-Object -Last 10
Write-Output "=== WEBVIEW ==="; $web | ForEach-Object { $_.ToString() }
& $adb shell screencap -p /sdcard/sb-smoke.png 2>$null
& $adb pull /sdcard/sb-smoke.png "$env:TEMP\sb-smoke.png" 2>$null | Out-Null
Write-Output "SCREENSHOT=$env:TEMP\sb-smoke.png"
exit 0
