# Builds Slides Forever and puts a ready-to-copy folder in .\dist\SlidesForever
# Works with either Rust toolchain:
#   - MSVC (Visual Studio Build Tools): produces a single self-contained SlidesForever.exe
#   - GNU/MinGW (MSYS2): SlidesForever.exe + WebView2Loader.dll (keep them together)
Set-Location $PSScriptRoot

if (Test-Path 'C:\msys64\mingw64\bin\windres.exe') { $env:PATH = "C:\msys64\mingw64\bin;$env:PATH" }

cargo test --release
if ($LASTEXITCODE -ne 0) { throw 'tests failed' }
cargo build --release
if ($LASTEXITCODE -ne 0) { throw 'build failed' }

$target = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { 'target' }
$out = Join-Path $PSScriptRoot 'dist\SlidesForever'
New-Item -ItemType Directory -Force $out | Out-Null
Copy-Item (Join-Path $target 'release\slides-forever.exe') (Join-Path $out 'SlidesForever.exe') -Force
$dll = Join-Path $target 'release\WebView2Loader.dll'
$imports = & objdump -p (Join-Path $out 'SlidesForever.exe') 2>$null | Select-String 'WebView2Loader.dll'
if ($imports -and (Test-Path $dll)) { Copy-Item $dll $out -Force }
Write-Host "Done -> $out"
