# Copy to build.local.ps1 (git-ignored) and fill in your signing details.
# Keep the same keystore for every update so Android can install in place.
$Keystore = Join-Path $PSScriptRoot "superbox.keystore"
$Alias = "superbox"
$StorePass = "change-me"
$KeyPass = "change-me"
