param(
    [switch]$Uninstall,
    [switch]$Test,
    [switch]$Yes,
    [string]$Version = "latest",
    [string]$Repo = "marcusgrando/tab-reaper"
)

$ErrorActionPreference = "Stop"

$Interactive = $false
if (-not $Yes -and [Environment]::UserInteractive) {
    try {
        $null = $Host.UI.RawUI
        $Interactive = $true
    } catch {}
}

function Write-Step([string]$Num, [string]$Message) {
    Write-Host "[$Num] " -ForegroundColor Cyan -NoNewline
    Write-Host $Message
}

function Write-Ok([string]$Message) {
    Write-Host "  OK " -ForegroundColor Green -NoNewline
    Write-Host $Message
}

function Write-Note([string]$Message) {
    Write-Host "  Note: " -ForegroundColor Yellow -NoNewline
    Write-Host $Message
}

function Confirm-YesNo([string]$Question) {
    $Reply = Read-Host "$Question [Y/n]"
    return ($Reply -eq "" -or $Reply -match '^(y|yes|s|sim)$')
}

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
    Write-Host "Tab Reaper removed." -ForegroundColor Green
    Write-Host "Removed $AppDir and registry entries."
    Write-Host "If Tab Reaper is still listed in chrome://extensions, click Remove there."
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

function Find-ChromiumBrowser {
    $Bases = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    $Specs = @(
        @{ Name = "Google Chrome"; RelPath = "Google\Chrome\Application\chrome.exe" },
        @{ Name = "Brave"; RelPath = "BraveSoftware\Brave-Browser\Application\brave.exe" },
        @{ Name = "Chromium"; RelPath = "Chromium\Application\chrome.exe" }
    )
    foreach ($Spec in $Specs) {
        foreach ($Base in $Bases) {
            $Candidate = Join-Path $Base $Spec.RelPath
            if (Test-Path $Candidate) {
                return @{ Name = $Spec.Name; Path = $Candidate }
            }
        }
    }
    return $null
}

New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
$TmpDir = Join-Path $AppDir (".staging-" + [System.Guid]::NewGuid().ToString("N"))
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

$IsUpdate = Test-Path (Join-Path $ExtDir "manifest.json")
$WinArch = Get-WindowsArch

Write-Host ""
Write-Host ("Tab Reaper " + $(if ($IsUpdate) { "Updater" } else { "Installer" })) -ForegroundColor White
Write-Host "Platform: windows ($WinArch) | Release: $Version" -ForegroundColor DarkGray
Write-Host ""

try {
    $SumsPath = Join-Path $TmpDir "SHA256SUMS.txt"
    $ZipPath = Join-Path $TmpDir "tab-reaper-extension.zip"
    $HostTmpPath = Join-Path $TmpDir "tab-reaper-host.exe"
    $ExtractDir = Join-Path $TmpDir "extracted"

    Write-Step "1/4" "Downloading extension and verifying checksum..."
    Invoke-WebRequest -Uri (Get-ReleaseUrl "SHA256SUMS.txt") -OutFile $SumsPath -UseBasicParsing
    Invoke-WebRequest -Uri (Get-ReleaseUrl "tab-reaper-extension.zip") -OutFile $ZipPath -UseBasicParsing
    Test-AssetChecksum $SumsPath "tab-reaper-extension.zip" $ZipPath
    Expand-Archive -Path $ZipPath -DestinationPath $ExtractDir -Force

    $HostAsset = "tab-reaper-host-windows-$WinArch.exe"
    Write-Step "2/4" "Downloading Local Companion ($HostAsset) and verifying checksum..."
    Invoke-WebRequest -Uri (Get-ReleaseUrl $HostAsset) -OutFile $HostTmpPath -UseBasicParsing
    Test-AssetChecksum $SumsPath $HostAsset $HostTmpPath

    if (Test-Path $ExtDir) {
        Remove-Item -Path $ExtDir -Recurse -Force
    }
    Move-Item -Path $ExtractDir -Destination $ExtDir

    $ExtId = Get-ChromeExtensionId $ExtDir
    Write-Ok "Extension installed to $ExtDir"

    $OldBinPath = "$BinPath.old"
    if (Test-Path $OldBinPath) {
        Remove-Item -Path $OldBinPath -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path $BinPath) {
        Move-Item -Path $BinPath -Destination $OldBinPath -Force
    }
    Move-Item -Path $HostTmpPath -Destination $BinPath -Force
    Remove-Item -Path $OldBinPath -Force -ErrorAction SilentlyContinue
    Write-Ok "Local Companion installed to $BinPath"

    Write-Step "3/4" "Registering Local Companion with browsers..."
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
    Write-Ok "Registered for Chrome, Chromium, Brave (Extension ID: $ExtId)"

    Write-Step "4/4" "Verifying Local Companion..."
    $SelfTestOutput = $null
    $SelfTestOk = $false
    try {
        $SelfTestOutput = & $BinPath --once 2>&1
        if ($LASTEXITCODE -eq 0) {
            $SelfTestOk = $true
        }
    } catch {}
    if ($SelfTestOk) {
        Write-Ok "Companion self-test passed."
        if ($Test -and $SelfTestOutput) {
            Write-Host $SelfTestOutput
        }
    } else {
        Write-Note "Companion binary installed. Memory reporting activates once Chrome is running."
        if ($Test -and $SelfTestOutput) {
            Write-Host $SelfTestOutput
        }
    }

    $CopiedNote = ""
    try {
        Set-Clipboard -Value $ExtDir
        $CopiedNote = " (already copied to clipboard)"
    } catch {}

    $Browser = Find-ChromiumBrowser
    Write-Host ""

    if ($IsUpdate) {
        Write-Host "Update complete." -ForegroundColor Green
        Write-Host "  1. Open chrome://extensions"
        Write-Host "  2. Click the Reload icon on the Tab Reaper card."
        if ($Interactive -and $Browser) {
            Write-Host ""
            if (Confirm-YesNo "Open $($Browser.Name) at chrome://extensions now?") {
                Start-Process -FilePath $Browser.Path -ArgumentList "chrome://extensions"
            }
        }
    } else {
        Write-Host "Final step in Chrome (one-time):" -ForegroundColor White
        Write-Host "  1. Open chrome://extensions and turn on Developer mode (top right)."
        Write-Host "  2. Drag the 'extension' folder onto the chrome://extensions page"
        Write-Host "     or click 'Load unpacked' and select:"
        Write-Host "     $ExtDir$CopiedNote"
        Write-Host "  3. Tab Reaper Settings will open automatically to finish setup in 1 click."

        if ($Interactive) {
            Write-Host ""
            if ($Browser) {
                if (Confirm-YesNo "Open $($Browser.Name) (chrome://extensions) and the extension folder now?") {
                    Start-Process -FilePath $Browser.Path -ArgumentList "chrome://extensions"
                    Start-Process -FilePath "explorer.exe" -ArgumentList "/select,`"$ExtDir`""
                    Write-Host ""
                    Write-Ok "Opened $($Browser.Name) and Explorer. Drag 'extension' onto chrome://extensions."
                }
            } else {
                if (Confirm-YesNo "Open the extension folder in Explorer now?") {
                    Start-Process -FilePath "explorer.exe" -ArgumentList "/select,`"$ExtDir`""
                    Write-Host ""
                    Write-Ok "Opened Explorer. Drag 'extension' onto chrome://extensions."
                }
            }
        }
    }

    Write-Host ""
    Write-Host "To uninstall later:" -ForegroundColor DarkGray
    Write-Host "  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/$Repo/main/install.ps1))) -Uninstall"
} finally {
    Remove-Item -Path $TmpDir -Recurse -Force -ErrorAction SilentlyContinue
}
