param(
    [switch]$Uninstall,
    [switch]$Test,
    [string]$Version = "latest",
    [string]$Repo = "marcusgrando/tab-reaper"
)

$ErrorActionPreference = "Stop"

$AppDir = Join-Path $env:LOCALAPPDATA "TabReaper"
$ExtDir = Join-Path $AppDir "extension"
$BinPath = Join-Path $AppDir "tab-reaper-host.exe"
$ManifestPath = Join-Path $AppDir "com.tabreaper.host.json"

$RegistryKeys = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.tabreaper.host",
    "HKCU:\Software\Chromium\NativeMessagingHosts\com.tabreaper.host",
    "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.tabreaper.host"
)

if ($Uninstall) {
    foreach ($Key in $RegistryKeys) {
        if (Test-Path $Key) {
            Remove-Item -Path $Key -Recurse -Force
        }
    }
    if (Test-Path $AppDir) {
        Remove-Item -Path $AppDir -Recurse -Force
    }
    Write-Host "Tab Reaper removed from $AppDir and registry entries cleaned up."
    Write-Host "If still listed in chrome://extensions, click Remove there."
    exit 0
}

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

function Get-ChromeExtensionId([string]$FolderPath) {
    $Normalized = [System.IO.Path]::GetFullPath($FolderPath).TrimEnd('\')
    if ($Normalized.Length -ge 2 -and $Normalized[1] -eq ':') {
        $Normalized = $Normalized.Substring(0, 1).ToUpperInvariant() + $Normalized.Substring(1)
    }
    $Bytes = [System.Text.Encoding]::Unicode.GetBytes($Normalized)
    $Sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $Hash = $Sha.ComputeHash($Bytes)
    } finally {
        $Sha.Dispose()
    }
    $Chars = New-Object char[] 32
    for ($i = 0; $i -lt 16; $i++) {
        $b = $Hash[$i]
        $Chars[$i * 2]     = [char]([int][char]'a' + (($b -shr 4) -band 0x0F))
        $Chars[$i * 2 + 1] = [char]([int][char]'a' + ($b -band 0x0F))
    }
    return -join $Chars
}

$TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("tab-reaper-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null

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

try {
    $SumsPath = Join-Path $TmpDir "SHA256SUMS.txt"
    $ZipPath = Join-Path $TmpDir "tab-reaper-extension.zip"
    $HostTmpPath = Join-Path $TmpDir "tab-reaper-host.exe"
    $ExtractDir = Join-Path $TmpDir "extracted"

    Write-Host "Downloading release checksums..."
    Invoke-WebRequest -Uri (Get-ReleaseUrl "SHA256SUMS.txt") -OutFile $SumsPath -UseBasicParsing

    Write-Host "Downloading Tab Reaper extension..."
    Invoke-WebRequest -Uri (Get-ReleaseUrl "tab-reaper-extension.zip") -OutFile $ZipPath -UseBasicParsing
    Test-AssetChecksum $SumsPath "tab-reaper-extension.zip" $ZipPath
    Expand-Archive -Path $ZipPath -DestinationPath $ExtractDir -Force

    New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
    if (Test-Path $ExtDir) {
        Remove-Item -Path $ExtDir -Recurse -Force
    }
    Move-Item -Path $ExtractDir -Destination $ExtDir

    $ExtId = Get-ChromeExtensionId $ExtDir

    $HostAsset = "tab-reaper-host-windows-$(Get-WindowsArch).exe"
    Write-Host "Downloading native memory host ($HostAsset)..."
    Invoke-WebRequest -Uri (Get-ReleaseUrl $HostAsset) -OutFile $HostTmpPath -UseBasicParsing
    Test-AssetChecksum $SumsPath $HostAsset $HostTmpPath
    Move-Item -Path $HostTmpPath -Destination $BinPath -Force

    $Manifest = @{
        name            = "com.tabreaper.host"
        description     = "Tab Reaper exact Chrome memory reporter"
        path            = $BinPath
        type            = "stdio"
        allowed_origins = @("chrome-extension://$ExtId/")
    } | ConvertTo-Json -Depth 3

    Set-Content -Path $ManifestPath -Value $Manifest -Encoding UTF8

    foreach ($Key in $RegistryKeys) {
        New-Item -Path $Key -Force | Out-Null
        Set-ItemProperty -Path $Key -Name "(default)" -Value $ManifestPath
    }

    if ($Test) {
        Write-Host "Self-test (--once):"
        & $BinPath --once
    }

    $CopiedNote = ""
    try {
        Set-Clipboard -Value $ExtDir
        $CopiedNote = " (already copied to your clipboard)"
    } catch {}

    Write-Host ""
    Write-Host "Tab Reaper installed to: $ExtDir"
    Write-Host "Pre-registered native host for Extension ID: $ExtId"
    Write-Host ""
    Write-Host "Final step in Chrome (required once for extensions outside the Web Store):"
    Write-Host "  1. Open chrome://extensions and enable Developer mode (top right)"
    Write-Host "  2. Click 'Load unpacked' and select:"
    Write-Host "     $ExtDir$CopiedNote"
    Write-Host "  3. (Optional) Open Tab Reaper Settings -> click Enable & Test on Exact Chrome RAM"
    Write-Host ""
    Write-Host "To uninstall later:"
    Write-Host "  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/$Repo/main/install.ps1))) -Uninstall"
} finally {
    Remove-Item -Path $TmpDir -Recurse -Force -ErrorAction SilentlyContinue
}
