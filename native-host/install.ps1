param(
    [Parameter(Position = 0)]
    [string]$ExtensionId,
    [switch]$FromSource,
    [switch]$Test,
    [string]$Version = "latest",
    [string]$Repo = "marcusgrando/tab-reaper"
)

$ErrorActionPreference = "Stop"

if (-not $ExtensionId) {
    Write-Error "Usage: install.ps1 [-FromSource] [-Test] <chrome-extension-id>`nCopy the full 32-character Extension ID from chrome://extensions or Tab Reaper Settings."
    exit 1
}

if ($ExtensionId -notmatch '^[a-p]{32}$') {
    Write-Error "Invalid Chrome extension ID '$ExtensionId' (got $($ExtensionId.Length) chars; expected 32 lowercase letters a-p)."
    exit 1
}

$InstallDir = Join-Path $env:LOCALAPPDATA "TabReaper"
$BinPath = Join-Path $InstallDir "tab-reaper-host.exe"
$ManifestPath = Join-Path $InstallDir "com.tabreaper.host.json"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { "" }
$CargoToml = if ($ScriptDir) { Join-Path $ScriptDir "Cargo.toml" } else { "" }

function Get-WindowsArch {
    $arch = $null
    try {
        $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
    } catch {}
    switch ($arch) {
        "arm64" { return "arm64" }
        "x64"   { return "x86_64" }
        "x86"   { return "x86" }
        default {
            if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { return "arm64" }
            if ([Environment]::Is64BitOperatingSystem) { return "x86_64" }
            return "x86"
        }
    }
}

function Get-ReleaseUrl([string]$Asset) {
    if ($Version -eq "latest") {
        return "https://github.com/$Repo/releases/latest/download/$Asset"
    }
    return "https://github.com/$Repo/releases/download/$Version/$Asset"
}

function Test-AssetChecksum([string]$SumsPath, [string]$AssetName, [string]$FilePath) {
    $Expected = $null
    foreach ($Line in Get-Content -Path $SumsPath) {
        if ($Line -match '^\s*([0-9a-fA-F]{64})\s+\*?(.+?)\s*$') {
            if ($Matches[2] -eq $AssetName) {
                $Expected = $Matches[1].ToLowerInvariant()
                break
            }
        }
    }
    if (-not $Expected) {
        throw "Checksum for $AssetName not found in SHA256SUMS.txt."
    }
    $Actual = (Get-FileHash -Path $FilePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($Actual -ne $Expected) {
        throw "SHA-256 mismatch for $AssetName (expected $Expected, got $Actual)."
    }
}

function Build-FromSource {
    if (-not $CargoToml -or -not (Test-Path $CargoToml)) {
        throw "Local Cargo.toml not found for -FromSource build."
    }
    if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
        throw "cargo not found. Install Rust from https://rustup.rs or omit -FromSource to download a prebuilt binary."
    }
    $TargetDir = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $env:LOCALAPPDATA "TabReaper\target" }
    New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
    Write-Host "Building tab-reaper-host (release)..."
    $env:CARGO_TARGET_DIR = $TargetDir
    cargo build --release --manifest-path $CargoToml
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed." }
    Copy-Item -Force (Join-Path $TargetDir "release\tab-reaper-host.exe") $BinPath
}

function Download-Prebuilt {
    $Asset = "tab-reaper-host-windows-$(Get-WindowsArch).exe"
    $TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("tab-reaper-host-" + [System.Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null
    try {
        $SumsPath = Join-Path $TmpDir "SHA256SUMS.txt"
        $TmpBin = Join-Path $TmpDir $Asset

        Write-Host "Downloading release checksums..."
        Invoke-WebRequest -Uri (Get-ReleaseUrl "SHA256SUMS.txt") -OutFile $SumsPath -UseBasicParsing

        Write-Host "Downloading $Asset from GitHub Releases..."
        Invoke-WebRequest -Uri (Get-ReleaseUrl $Asset) -OutFile $TmpBin -UseBasicParsing

        Test-AssetChecksum $SumsPath $Asset $TmpBin
        Move-Item -Path $TmpBin -Destination $BinPath -Force
    } finally {
        Remove-Item -Path $TmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if ($FromSource) {
    Build-FromSource
} else {
    Download-Prebuilt
}

$Manifest = @{
    name            = "com.tabreaper.host"
    description     = "Tab Reaper exact Chrome memory reporter"
    path            = $BinPath
    type            = "stdio"
    allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json -Depth 3

Set-Content -Path $ManifestPath -Value $Manifest -Encoding UTF8

$RegistryKeys = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.tabreaper.host",
    "HKCU:\Software\Chromium\NativeMessagingHosts\com.tabreaper.host",
    "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.tabreaper.host"
)

foreach ($Key in $RegistryKeys) {
    New-Item -Path $Key -Force | Out-Null
    Set-ItemProperty -Path $Key -Name "(default)" -Value $ManifestPath
    Write-Host "Registered native host at $Key"
}

if ($Test) {
    Write-Host "Self-test (--once):"
    & $BinPath --once
}
