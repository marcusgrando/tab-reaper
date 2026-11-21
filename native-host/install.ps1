param(
    [Parameter(Position = 0)]
    [string]$ExtensionId,
    [switch]$FromSource,
    [string]$Version = "latest",
    [string]$Repo = "marcusgrando/tab-reaper"
)

$ErrorActionPreference = "Stop"

if (-not $ExtensionId) {
    Write-Error "Usage: install.ps1 [-FromSource] <chrome-extension-id>`nCopy the full 32-character Extension ID from chrome://extensions or Tab Reaper Settings."
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
    $Asset = "tab-reaper-host-windows-x86_64.exe"
    $Url = if ($Version -eq "latest") {
        "https://github.com/$Repo/releases/latest/download/$Asset"
    } else {
        "https://github.com/$Repo/releases/download/$Version/$Asset"
    }
    Write-Host "Downloading $Asset from GitHub Releases..."
    try {
        Invoke-WebRequest -Uri $Url -OutFile $BinPath -UseBasicParsing
        return $true
    } catch {
        return $false
    }
}

if ($FromSource) {
    Build-FromSource
} elseif (-not (Download-Prebuilt)) {
    if ($CargoToml -and (Test-Path $CargoToml) -and (Get-Command cargo -ErrorAction SilentlyContinue)) {
        Write-Host "Prebuilt binary not available yet; falling back to local Rust build..."
        Build-FromSource
    } else {
        throw "Failed to download prebuilt binary from https://github.com/$Repo/releases."
    }
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

Write-Host "Self-test (--once):"
& $BinPath --once
