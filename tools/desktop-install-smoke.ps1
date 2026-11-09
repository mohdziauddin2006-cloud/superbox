param(
    [string]$Setup = "dist\SuperBox-Setup-1.2.0.exe",
    [int]$WaitSeconds = 60,
    [switch]$Uninstall
)
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Output "INSTALL_START"
$install = Start-Process -FilePath (Resolve-Path $Setup) -ArgumentList "/S" -PassThru -WindowStyle Hidden
$install.WaitForExit(180000) | Out-Null
Write-Output "INSTALL_EXIT=$($install.ExitCode)"

$candidates = @(
    (Join-Path $env:ProgramFiles "SuperBox\SuperBox.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\SuperBox\SuperBox.exe")
)
$exe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) { throw "Installed executable not found in: $($candidates -join ', ')" }
$appDir = Split-Path -Parent $exe
Write-Output "INSTALLED=$exe"
(Get-Item $exe).VersionInfo | Select-Object ProductName,ProductVersion,FileVersion | Format-List

$env:SB_HEADLESS = "1"
$app = Start-Process -FilePath $exe -ArgumentList @("--mute-audio", "--disable-audio-output") -WorkingDirectory $appDir -WindowStyle Hidden -PassThru -RedirectStandardOutput "$env:TEMP\sb-installed-out.txt" -RedirectStandardError "$env:TEMP\sb-installed-err.txt"
Write-Output "INSTALLED_PID=$($app.Id)"

$deadline = (Get-Date).AddSeconds($WaitSeconds)
do {
    Start-Sleep -Milliseconds 500
    $ok = $false
    try { $null = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:9333/json/version" -TimeoutSec 2; $ok = $true } catch {}
} while (-not $ok -and (Get-Date) -lt $deadline)
if (-not $ok) { throw "Installed app did not expose CDP within $WaitSeconds s" }
Write-Output "CDP_OK"

node tools\cdp-run.mjs 9333 tools\probe-boot.js 2>&1 | Select-Object -Last 4

Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Get-Process "SuperBox" -ErrorAction SilentlyContinue | Stop-Process -Force

if ($Uninstall) {
    $uninstaller = Join-Path $appDir "Uninstall SuperBox.exe"
    if (Test-Path $uninstaller) {
        Write-Output "UNINSTALL_START"
        Start-Process -FilePath $uninstaller -ArgumentList "/S" -WindowStyle Hidden
        Start-Sleep -Seconds 12
        Write-Output "UNINSTALL_LEFT=$(Test-Path $exe)"
    }
}
Write-Output "DONE"
exit 0
