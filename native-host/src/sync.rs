use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, OpenOptions as DirOptions};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_SYNC_FILE_BYTES: usize = 800 * 1024; // Stays safely under Chrome's 1 MB native messaging host->extension limit.
const SYNC_SUBDIR_NAME: &str = "TabReaper";

#[derive(Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct HostConfig {
    /// Per-Chrome-profile (deviceId) approved sync folder mapping so one profile
    /// never implicitly opts another profile into syncing its browsing data.
    #[serde(default, rename = "syncDirs")]
    pub sync_dirs: HashMap<String, String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct FolderCandidate {
    pub provider: String,
    pub label: String,
    pub path: String,
    pub exists: bool,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SyncFileEntry {
    #[serde(rename = "relPath")]
    pub rel_path: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    #[serde(rename = "modifiedMs")]
    pub modified_ms: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SyncStatus {
    pub enabled: bool,
    #[serde(rename = "syncDir")]
    pub sync_dir: Option<String>,
    /// Proven by a probe write when the user approves the folder. Status polls only check that
    /// the folder still opens, so a later permission change shows up as a sync_write error.
    pub writable: bool,
    pub hostname: String,
}

impl SyncStatus {
    fn disabled(hostname: String) -> Self {
        Self {
            enabled: false,
            sync_dir: None,
            writable: false,
            hostname,
        }
    }
}

fn temp_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

pub fn get_hostname() -> String {
    if let Ok(h) = env::var("COMPUTERNAME") {
        let trimmed = h.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Ok(h) = env::var("HOSTNAME") {
        let trimmed = h.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Some(h) = os_hostname() {
        let trimmed = h.trim();
        if !trimmed.is_empty() {
            return trimmed
                .strip_suffix(".local")
                .unwrap_or(trimmed)
                .to_string();
        }
    }
    format!("{}-device", env::consts::OS)
}

/// The name `hostname(1)` prints, read without spawning it.
#[cfg(unix)]
fn os_hostname() -> Option<String> {
    use std::ffi::{c_char, c_int};
    extern "C" {
        fn gethostname(name: *mut c_char, len: usize) -> c_int;
    }
    let mut buf = [0u8; 256];
    // SAFETY: gethostname writes at most `buf.len()` bytes into `buf`.
    if unsafe { gethostname(buf.as_mut_ptr().cast(), buf.len()) } != 0 {
        return None;
    }
    // A truncated name may lack the NUL terminator; treat it as unavailable.
    let end = buf.iter().position(|&b| b == 0)?;
    Some(String::from_utf8_lossy(&buf[..end]).into_owned())
}

/// The DNS host name, which is what `hostname.exe` prints.
#[cfg(windows)]
fn os_hostname() -> Option<String> {
    const COMPUTER_NAME_DNS_HOSTNAME: i32 = 1;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetComputerNameExW(name_type: i32, buffer: *mut u16, size: *mut u32) -> i32;
    }
    let mut buf = [0u16; 256];
    let mut len = buf.len() as u32;
    // SAFETY: `len` holds the capacity of `buf` in UTF-16 units. On success it holds the length
    // written, excluding the terminator.
    if unsafe { GetComputerNameExW(COMPUTER_NAME_DNS_HOSTNAME, buf.as_mut_ptr(), &mut len) } == 0 {
        return None;
    }
    Some(String::from_utf16_lossy(&buf[..len as usize]))
}

#[cfg(not(any(unix, windows)))]
fn os_hostname() -> Option<String> {
    None
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        env::var_os("USERPROFILE").map(PathBuf::from)
    }
    #[cfg(not(target_os = "windows"))]
    {
        env::var_os("HOME").map(PathBuf::from)
    }
}

pub fn host_config_path() -> Result<PathBuf, String> {
    if let Ok(override_path) = env::var("TAB_REAPER_HOST_CONFIG") {
        if !override_path.trim().is_empty() {
            return Ok(PathBuf::from(override_path));
        }
    }

    #[cfg(target_os = "macos")]
    {
        let home = home_dir().ok_or_else(|| "HOME not set".to_string())?;
        Ok(home
            .join("Library")
            .join("Application Support")
            .join("TabReaper")
            .join("host.json"))
    }
    #[cfg(target_os = "windows")]
    {
        let appdata = env::var_os("APPDATA")
            .map(PathBuf::from)
            .or_else(home_dir)
            .ok_or_else(|| "APPDATA not set".to_string())?;
        Ok(appdata.join("TabReaper").join("host.json"))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        if let Some(xdg) = env::var_os("XDG_CONFIG_HOME") {
            return Ok(PathBuf::from(xdg).join("tab-reaper").join("host.json"));
        }
        let home = home_dir().ok_or_else(|| "HOME not set".to_string())?;
        Ok(home.join(".config").join("tab-reaper").join("host.json"))
    }
}

pub fn validate_device_id(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > 64 {
        return Err("invalid deviceId".to_string());
    }
    if !trimmed
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
    {
        return Err("deviceId contains disallowed characters".to_string());
    }
    Ok(trimmed.to_string())
}

fn read_host_config() -> Result<HostConfig, String> {
    match fs::read(host_config_path()?) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|e| format!("invalid host config: {e}"))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(HostConfig::default()),
        Err(e) => Err(format!("read host config: {e}")),
    }
}

// Lock a stable sibling because replacing host.json also replaces its inode.
fn lock_config(exclusive: bool) -> Result<fs::File, String> {
    let path = host_config_path()?.with_extension("lock");
    fs::create_dir_all(path.parent().ok_or("missing config parent")?).map_err(|e| e.to_string())?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|e| format!("open host config lock: {e}"))?;
    if exclusive {
        file.lock()
    } else {
        file.lock_shared()
    }
    .map_err(|e| format!("lock host config: {e}"))?;
    Ok(file)
}

pub struct DestinationGuard {
    _lock: fs::File,
    device_id: String,
    root: PathBuf,
}

impl DestinationGuard {
    pub fn write(&self, rel_path: &str, content: &str) -> Result<usize, String> {
        write_in_root(&self.device_id, &self.root, rel_path, content)
    }

    pub fn read(&self, rel_path: &str) -> Result<Option<String>, String> {
        read_in_root(&self.root, rel_path)
    }

    pub fn delete(&self, rel_path: &str) -> Result<bool, String> {
        delete_in_root(&self.device_id, &self.root, rel_path)
    }

    pub fn list(
        &self,
        rel_prefix: Option<&str>,
        max_depth: Option<usize>,
    ) -> Result<Vec<SyncFileEntry>, String> {
        list_in_root(&self.root, rel_prefix, max_depth)
    }
}

pub fn lock_destination(device_id: &str, expected: Option<&str>) -> Result<DestinationGuard, String> {
    let expected = expected.ok_or("missing expectedDir")?;
    let lock = lock_config(false)?;
    let (dev, root) = require_sync_root_path(device_id)?;
    if root.as_os_str() != std::ffi::OsStr::new(expected) {
        return Err("sync folder changed".to_string());
    }
    Ok(DestinationGuard {
        _lock: lock,
        device_id: dev,
        root,
    })
}

pub fn save_host_config(cfg: &HostConfig) -> Result<(), String> {
    let path = host_config_path()?;
    let json = serde_json::to_string_pretty(cfg).map_err(|e| format!("serialize config: {e}"))?;
    let Some(parent) = path.parent() else {
        return Err("host config has no parent dir".to_string());
    };
    fs::create_dir_all(parent).map_err(|e| format!("create config dir: {e}"))?;
    let tmp = parent.join(format!(
        ".tmp.{}.{}.host.json",
        std::process::id(),
        temp_nanos()
    ));
    let mut f = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map_err(|e| format!("create host config tmp: {e}"))?;
    if let Err(err) = f.write_all(json.as_bytes()).and_then(|_| f.sync_all()) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("write host config: {err}"));
    }
    drop(f);
    if let Err(err) = fs::rename(&tmp, &path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("rename host config: {err}"));
    }
    Ok(())
}

fn expand_tilde(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("path is empty".to_string());
    }
    if let Some(rest) = trimmed.strip_prefix("~/") {
        let home = home_dir().ok_or_else(|| "cannot expand ~: HOME not set".to_string())?;
        return Ok(home.join(rest));
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err("sync folder path must be absolute".to_string());
    }
    Ok(path)
}

fn check_writable(dir: &Path) -> bool {
    let Ok(root) = open_root(dir) else {
        return false;
    };
    let probe = format!(".tab-reaper-probe-{}-{}.tmp", std::process::id(), temp_nanos());
    match root.open_with(&probe, DirOptions::new().write(true).create_new(true)) {
        Ok(file) => {
            drop(file);
            root.remove_file(&probe).is_ok()
        }
        Err(_) => false,
    }
}

pub fn set_sync_folder(device_id: &str, raw_path: Option<&str>) -> Result<SyncStatus, String> {
    let dev = validate_device_id(device_id)?;
    let _lock = lock_config(true)?;
    let mut cfg = read_host_config()?;

    let Some(raw) = raw_path.map(str::trim).filter(|s| !s.is_empty()) else {
        cfg.sync_dirs.remove(&dev);
        save_host_config(&cfg)?;
        return Ok(SyncStatus::disabled(get_hostname()));
    };

    let expanded = expand_tilde(raw)?;
    fs::create_dir_all(&expanded).map_err(|e| format!("cannot create sync folder: {e}"))?;
    let canonical =
        fs::canonicalize(&expanded).map_err(|e| format!("cannot resolve sync folder: {e}"))?;
    if !canonical.is_dir() {
        return Err("sync path is not a directory".to_string());
    }
    if !check_writable(&canonical) {
        return Err("sync folder is not writable".to_string());
    }

    let sync_dir_str = canonical.to_string_lossy().to_string();
    cfg.sync_dirs.insert(dev, sync_dir_str.clone());
    save_host_config(&cfg)?;

    Ok(SyncStatus {
        enabled: true,
        sync_dir: Some(sync_dir_str),
        writable: true,
        hostname: get_hostname(),
    })
}

pub fn get_sync_status(device_id: Option<&str>) -> SyncStatus {
    let hostname = get_hostname();
    let Some(raw_dev) = device_id else {
        return SyncStatus::disabled(hostname);
    };
    let Ok(dev) = validate_device_id(raw_dev) else {
        return SyncStatus::disabled(hostname);
    };

    let cfg = read_host_config().unwrap_or_default();
    let Some(dir) = cfg.sync_dirs.get(&dev).cloned() else {
        return SyncStatus::disabled(hostname);
    };
    // The extension polls this, so it only checks that the approved folder still opens without
    // following a swapped-in symlink. The create/delete probe runs when the user approves a
    // folder; later write failures surface from sync_write itself.
    let writable = open_root(Path::new(&dir)).is_ok();
    SyncStatus {
        enabled: true,
        sync_dir: Some(dir),
        writable,
        hostname,
    }
}

fn push_candidate(
    out: &mut Vec<FolderCandidate>,
    provider: &str,
    label: impl Into<String>,
    base: &Path,
) {
    let target = base.join(SYNC_SUBDIR_NAME);
    out.push(FolderCandidate {
        provider: provider.to_string(),
        label: label.into(),
        path: target.to_string_lossy().to_string(),
        exists: target.is_dir(),
    });
}

#[cfg(any(target_os = "macos", test))]
fn is_preserved_cloud_storage_name(name: &str) -> bool {
    let Some(without_close) = name.strip_suffix(')') else {
        return false;
    };
    let Some((prefix, inner)) = without_close.rsplit_once(" (") else {
        return false;
    };
    if prefix.is_empty() || inner.is_empty() {
        return false;
    }
    let has_digit = inner.bytes().any(|b| b.is_ascii_digit());
    let has_separator = inner.bytes().any(|b| matches!(b, b'-' | b':'));
    has_digit
        && has_separator
        && inner
            .bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'-' | b':' | b' '))
}

#[cfg(any(target_os = "macos", test))]
fn is_preserved_cloud_storage_dir(dir: &Path) -> bool {
    let name = dir.file_name().and_then(|s| s.to_str()).unwrap_or("");
    is_preserved_cloud_storage_name(name)
        || dir.join(".drive_fs_ignore_preserved_domain").exists()
}

#[cfg(target_os = "macos")]
fn has_file_provider_domain_id(path: &Path) -> bool {
    use std::ffi::{c_char, c_void, CString};
    use std::os::unix::ffi::OsStrExt;

    extern "C" {
        fn getxattr(
            path: *const c_char,
            name: *const c_char,
            value: *mut c_void,
            size: usize,
            position: u32,
            options: i32,
        ) -> isize;
    }

    const ENOATTR: i32 = 93;

    let Ok(c_path) = CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    let attr = b"com.apple.file-provider-domain-id\0";
    let ret = unsafe {
        getxattr(
            c_path.as_ptr(),
            attr.as_ptr().cast(),
            std::ptr::null_mut(),
            0,
            0,
            0,
        )
    };
    if ret >= 0 {
        return true;
    }
    io::Error::last_os_error().raw_os_error() != Some(ENOATTR)
}

pub fn detect_cloud_folders() -> Vec<FolderCandidate> {
    let mut out = Vec::new();
    let Some(home) = home_dir() else {
        return out;
    };

    #[cfg(target_os = "macos")]
    {
        let icloud = home
            .join("Library")
            .join("Mobile Documents")
            .join("com~apple~CloudDocs");
        if icloud.is_dir() {
            push_candidate(&mut out, "icloud", "iCloud Drive", &icloud);
        }

        let cloud_storage = home.join("Library").join("CloudStorage");
        if let Ok(entries) = fs::read_dir(&cloud_storage) {
            let mut dirs: Vec<PathBuf> = entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect();
            dirs.sort();
            for dir in dirs {
                if is_preserved_cloud_storage_dir(&dir) || !has_file_provider_domain_id(&dir) {
                    continue;
                }
                let name = dir.file_name().and_then(|s| s.to_str()).unwrap_or("");
                if let Some(account) = name.strip_prefix("GoogleDrive-") {
                    let my_drive = dir.join("My Drive");
                    let base = if my_drive.is_dir() { &my_drive } else { &dir };
                    push_candidate(
                        &mut out,
                        "google_drive",
                        format!("Google Drive ({account})"),
                        base,
                    );
                } else if let Some(account) = name.strip_prefix("OneDrive-") {
                    push_candidate(&mut out, "onedrive", format!("OneDrive ({account})"), &dir);
                } else if name.starts_with("Dropbox") {
                    push_candidate(&mut out, "dropbox", "Dropbox", &dir);
                }
            }
        }

        let dropbox = home.join("Dropbox");
        if dropbox.is_dir() && !out.iter().any(|c| c.provider == "dropbox") {
            push_candidate(&mut out, "dropbox", "Dropbox", &dropbox);
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(onedrive) = env::var_os("OneDrive").map(PathBuf::from) {
            if onedrive.is_dir() {
                push_candidate(&mut out, "onedrive", "OneDrive", &onedrive);
            }
        }
        let icloud = home.join("iCloudDrive");
        if icloud.is_dir() {
            push_candidate(&mut out, "icloud", "iCloud Drive", &icloud);
        }
        for gd in [PathBuf::from("G:\\My Drive"), home.join("Google Drive")] {
            if gd.is_dir() {
                push_candidate(&mut out, "google_drive", "Google Drive", &gd);
                break;
            }
        }
        let dropbox = home.join("Dropbox");
        if dropbox.is_dir() {
            push_candidate(&mut out, "dropbox", "Dropbox", &dropbox);
        }
    }

    #[cfg(target_os = "linux")]
    {
        for (provider, label, folder) in [
            ("dropbox", "Dropbox", home.join("Dropbox")),
            ("nextcloud", "Nextcloud", home.join("Nextcloud")),
            ("syncthing", "Sync", home.join("Sync")),
            ("documents", "Documents", home.join("Documents")),
        ] {
            if folder.is_dir() {
                push_candidate(&mut out, provider, label, &folder);
            }
        }
    }

    out
}

pub fn pick_folder_dialog() -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        let out = Command::new("osascript")
            .args([
                "-e",
                "POSIX path of (choose folder with prompt \"Choose Tab Reaper sync folder\")",
            ])
            .output()
            .map_err(|e| format!("failed to launch folder picker: {e}"))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            if stderr.contains("-128") || stderr.to_ascii_lowercase().contains("cancel") {
                return Ok(None);
            }
            return Err(format!("folder picker failed: {}", stderr.trim()));
        }
        let picked = String::from_utf8_lossy(&out.stdout)
            .trim()
            .trim_end_matches('/')
            .to_string();
        if picked.is_empty() {
            return Ok(None);
        }
        Ok(Some(picked))
    }

    #[cfg(target_os = "windows")]
    {
        let script = r#"
Add-Type -AssemblyName System.Windows.Forms
$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.Description = 'Choose Tab Reaper sync folder'
$dlg.UseDescriptionForTitle = $true
if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dlg.SelectedPath
}
"#;
        let out = Command::new("powershell")
            .args(["-NoProfile", "-STA", "-Command", script])
            .output()
            .map_err(|e| format!("failed to launch folder picker: {e}"))?;
        if !out.status.success() {
            return Err("folder picker failed".to_string());
        }
        let picked = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if picked.is_empty() {
            return Ok(None);
        }
        Ok(Some(picked))
    }

    #[cfg(target_os = "linux")]
    {
        if let Ok(out) = Command::new("zenity")
            .args([
                "--file-selection",
                "--directory",
                "--title=Choose Tab Reaper sync folder",
            ])
            .output()
        {
            if out.status.success() {
                let picked = String::from_utf8_lossy(&out.stdout).trim().to_string();
                return Ok(if picked.is_empty() {
                    None
                } else {
                    Some(picked)
                });
            }
            return Ok(None);
        }
        if let Ok(out) = Command::new("kdialog")
            .args([
                "--getexistingdirectory",
                "--title",
                "Choose Tab Reaper sync folder",
            ])
            .output()
        {
            if out.status.success() {
                let picked = String::from_utf8_lossy(&out.stdout).trim().to_string();
                return Ok(if picked.is_empty() {
                    None
                } else {
                    Some(picked)
                });
            }
            return Ok(None);
        }
        Err(
            "No supported folder picker (zenity/kdialog) found; enter a folder path manually."
                .to_string(),
        )
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Err("Folder picker not supported on this platform".to_string())
    }
}

fn require_sync_root_path(device_id: &str) -> Result<(String, PathBuf), String> {
    let dev = validate_device_id(device_id)?;
    let cfg = read_host_config()?;
    let Some(dir) = cfg.sync_dirs.get(&dev) else {
        return Err("sync folder is not configured for this profile".to_string());
    };
    let root = PathBuf::from(dir);
    if !root.is_absolute() {
        return Err("configured sync folder must be absolute".to_string());
    }
    Ok((dev, root))
}

pub fn validate_rel_path(rel_path: &str, allow_dir_prefix: bool) -> Result<Vec<String>, String> {
    let trimmed = rel_path.trim();
    if trimmed.is_empty() {
        if allow_dir_prefix {
            return Ok(Vec::new());
        }
        return Err("relPath is empty".to_string());
    }
    if trimmed.len() > 240 || trimmed.starts_with('/') || trimmed.contains('\\') {
        return Err("invalid relPath".to_string());
    }
    if !trimmed
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'/'))
    {
        return Err("relPath contains disallowed characters".to_string());
    }

    let path = Path::new(trimmed);
    let mut parts = Vec::new();
    for comp in path.components() {
        match comp {
            Component::Normal(part) => {
                let s = part.to_string_lossy().to_string();
                if s.starts_with('.') {
                    return Err("hidden path segments are not allowed".to_string());
                }
                parts.push(s);
            }
            _ => return Err("path traversal is not allowed".to_string()),
        }
    }

    if !allow_dir_prefix {
        // Strict single-writer layout: every writable file lives under devices/<deviceId>/*.json
        if !trimmed.starts_with("devices/") || !trimmed.ends_with(".json") || parts.len() < 3 {
            return Err("relPath must be under devices/<deviceId>/ and end with .json".to_string());
        }
    } else if !(trimmed == "devices" || trimmed.starts_with("devices/")) {
        return Err("relPrefix must be empty or under devices/".to_string());
    }

    Ok(parts)
}

fn require_owned_rel_path(device_id: &str, rel_path: &str) -> Result<Vec<String>, String> {
    let parts = validate_rel_path(rel_path, false)?;
    if parts.get(1).map(String::as_str) != Some(device_id) {
        return Err("writes and deletes are restricted to this device's own folder".to_string());
    }
    Ok(parts)
}

// The configured path was canonicalized when the user approved it. Open each
// component relative to its parent so a later redirection cannot change the destination.
fn open_root(path: &Path) -> io::Result<Dir> {
    let mut components = path.components();
    let mut anchor = PathBuf::new();
    while let Some(component @ (Component::Prefix(_) | Component::RootDir)) =
        components.clone().next()
    {
        anchor.push(component.as_os_str());
        components.next();
    }
    if !anchor.is_absolute() {
        return Err(io::Error::other("sync folder must be absolute"));
    }
    let mut dir = Dir::open_ambient_dir(anchor, cap_std::ambient_authority())?;
    for component in components {
        let Component::Normal(name) = component else {
            return Err(io::Error::other("invalid sync root"));
        };
        dir = dir.open_dir_nofollow(name)?;
    }
    Ok(dir)
}

fn open_subdir(mut dir: Dir, parts: &[String], create: bool) -> io::Result<Dir> {
    for part in parts {
        dir = match dir.open_dir_nofollow(part) {
            Err(e) if create && e.kind() == io::ErrorKind::NotFound => {
                if let Err(e) = dir.create_dir(part) {
                    if e.kind() != io::ErrorKind::AlreadyExists {
                        return Err(e);
                    }
                }
                dir.open_dir_nofollow(part)?
            }
            result => result?,
        };
    }
    Ok(dir)
}

fn optional<T>(result: io::Result<T>) -> Result<Option<T>, String> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn write_in_root(device_id: &str, root: &Path, rel_path: &str, content: &str) -> Result<usize, String> {
    if content.len() > MAX_SYNC_FILE_BYTES {
        return Err(format!(
            "file exceeds max size ({MAX_SYNC_FILE_BYTES} bytes)"
        ));
    }
    let parts = require_owned_rel_path(device_id, rel_path)?;
    let (name, parents) = parts.split_last().ok_or("empty path")?;
    let dir = open_subdir(open_root(root).map_err(|e| e.to_string())?, parents, true)
        .map_err(|e| format!("open sync directory: {e}"))?;
    let tmp = format!(".tmp.{}.{}", std::process::id(), temp_nanos());
    let mut options = DirOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    cap_std::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = dir
        .open_with(&tmp, &options)
        .map_err(|e| format!("create temp file: {e}"))?;
    let result = file
        .write_all(content.as_bytes())
        .and_then(|_| file.sync_all());
    drop(file);
    if let Err(e) = result.and_then(|_| dir.rename(&tmp, &dir, name)) {
        let _ = dir.remove_file(tmp);
        return Err(format!("save sync file: {e}"));
    }
    Ok(content.len())
}

fn read_in_root(root: &Path, rel_path: &str) -> Result<Option<String>, String> {
    let parts = validate_rel_path(rel_path, false)?;
    let (name, parents) = parts.split_last().ok_or("empty path")?;
    let root = open_root(root).map_err(|e| format!("open sync folder: {e}"))?;
    let Some(dir) = optional(open_subdir(root, parents, false))? else {
        return Ok(None);
    };
    let mut options = DirOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let Some(meta) = optional(dir.symlink_metadata(name))? else {
        return Ok(None);
    };
    if !meta.is_file() {
        return Err("expected regular file".into());
    }
    let Some(file) = optional(dir.open_with(name, &options))? else {
        return Ok(None);
    };
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("expected regular file".into());
    }
    let mut result = String::new();
    file.take(MAX_SYNC_FILE_BYTES as u64 + 1)
        .read_to_string(&mut result)
        .map_err(|e| format!("read sync file: {e}"))?;
    if result.len() > MAX_SYNC_FILE_BYTES {
        return Err("sync file exceeds safe read limit".into());
    }
    Ok(Some(result))
}

fn delete_in_root(device_id: &str, root: &Path, rel_path: &str) -> Result<bool, String> {
    let parts = require_owned_rel_path(device_id, rel_path)?;
    let (name, parents) = parts.split_last().ok_or("empty path")?;
    let root = open_root(root).map_err(|e| format!("open sync folder: {e}"))?;
    let Some(dir) = optional(open_subdir(root, parents, false))? else {
        return Ok(false);
    };
    Ok(optional(dir.remove_file(name))?.is_some())
}

fn list_in_root(
    root: &Path,
    rel_prefix: Option<&str>,
    max_depth: Option<usize>,
) -> Result<Vec<SyncFileEntry>, String> {
    let mut parts = validate_rel_path(rel_prefix.unwrap_or(""), true)?;
    if parts.is_empty() {
        parts.push("devices".to_string());
    }
    let root = open_root(root).map_err(|e| format!("open sync folder: {e}"))?;
    let Some(dir) = optional(open_subdir(root, &parts, false))? else {
        return Ok(Vec::new());
    };
    let mut entries = Vec::new();
    collect_entries(
        &dir,
        &parts.join("/"),
        max_depth.unwrap_or(usize::MAX),
        &mut entries,
    )
    .map_err(|e| format!("list sync files: {e}"))?;
    entries.sort_by(|a, b| {
        b.modified_ms
            .cmp(&a.modified_ms)
            .then_with(|| a.rel_path.cmp(&b.rel_path))
    });
    Ok(entries)
}

#[cfg(test)]
pub fn sync_write(device_id: &str, rel_path: &str, content: &str) -> Result<usize, String> {
    let (dev, root) = require_sync_root_path(device_id)?;
    write_in_root(&dev, &root, rel_path, content)
}

#[cfg(test)]
pub fn sync_read(device_id: &str, rel_path: &str) -> Result<Option<String>, String> {
    let (_, root) = require_sync_root_path(device_id)?;
    read_in_root(&root, rel_path)
}

#[cfg(test)]
pub fn sync_delete(device_id: &str, rel_path: &str) -> Result<bool, String> {
    let (dev, root) = require_sync_root_path(device_id)?;
    delete_in_root(&dev, &root, rel_path)
}

#[cfg(test)]
pub fn sync_list(
    device_id: &str,
    rel_prefix: Option<&str>,
    max_depth: Option<usize>,
) -> Result<Vec<SyncFileEntry>, String> {
    let (_, root) = require_sync_root_path(device_id)?;
    list_in_root(&root, rel_prefix, max_depth)
}

fn collect_entries(
    dir: &Dir,
    prefix: &str,
    depth: usize,
    out: &mut Vec<SyncFileEntry>,
) -> io::Result<()> {
    for entry in dir.entries()? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if name.starts_with('.') {
            continue;
        }
        let rel_path = format!("{prefix}/{name}");
        let kind = entry.file_type()?;
        if kind.is_dir() && depth > 0 {
            collect_entries(&dir.open_dir_nofollow(name)?, &rel_path, depth - 1, out)?;
        } else if kind.is_file() && name.ends_with(".json") {
            let meta = dir.symlink_metadata(name)?;
            out.push(SyncFileEntry {
                rel_path,
                size_bytes: meta.len(),
                modified_ms: meta
                    .modified()?
                    .duration_since(cap_std::time::SystemTime::from_std(UNIX_EPOCH))
                    .unwrap_or_default()
                    .as_millis() as u64,
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn validates_relative_paths_strictly() {
        assert!(validate_rel_path("devices/abc-123/config.json", false).is_ok());
        assert!(validate_rel_path("devices/abc-123/meta.json", false).is_ok());
        assert!(validate_rel_path("devices/abc-123/snapshots/2026_1.json", false).is_ok());
        assert!(validate_rel_path("config.json", false).is_err());
        assert!(validate_rel_path("../secret.json", false).is_err());
        assert!(validate_rel_path("/etc/passwd", false).is_err());
        assert!(validate_rel_path("devices/../config.json", false).is_err());
        assert!(validate_rel_path("devices/.hidden/a.json", false).is_err());
        assert!(validate_rel_path("other.json", false).is_err());
        assert!(validate_rel_path("devices/abc/file.txt", false).is_err());
        assert!(validate_rel_path("devices", true).is_ok());
        assert!(validate_rel_path("devices/abc", true).is_ok());
        assert!(validate_rel_path("etc", true).is_err());
    }

    #[test]
    fn enforces_per_profile_opt_in_and_single_writer_ownership() {
        let _guard = ENV_LOCK.lock().unwrap();
        let base = env::temp_dir().join(format!(
            "tab-reaper-sync-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let cfg_file = base.join("host.json");
        let sync_dir = base.join("sync-root");
        env::set_var("TAB_REAPER_HOST_CONFIG", &cfg_file);

        let status1 = set_sync_folder("dev1", Some(sync_dir.to_str().unwrap())).unwrap();
        assert!(status1.enabled);
        assert!(status1.writable);

        let stale = serde_json::json!({
            "cmd": "sync_write", "deviceId": "dev1", "expectedDir": "previous-folder",
            "relPath": "devices/dev1/index.json", "content": "{}"
        });
        let reply: serde_json::Value =
            serde_json::from_str(&crate::handle_request(&stale.to_string())).unwrap();
        assert_eq!(reply["ok"], false);
        assert!(!sync_dir.join("devices/dev1/index.json").exists());

        let status2 = get_sync_status(Some("dev2"));
        assert!(!status2.enabled);
        assert!(sync_read("dev2", "devices/dev1/config.json").is_err());

        sync_write("dev1", "devices/dev1/config.json", r#"{"updatedAt":123}"#).unwrap();
        sync_write("dev1", "devices/dev1/meta.json", r#"{"deviceName":"Mac"}"#).unwrap();
        sync_write("dev1", "devices/dev1/snapshots/s1.json", r#"{"id":"s1"}"#).unwrap();

        assert!(sync_write("dev1", "devices/dev2/config.json", r#"{}"#).is_err());
        assert!(sync_delete("dev1", "devices/dev2/snapshots/s1.json").is_err());

        assert_eq!(
            sync_read("dev1", "devices/dev1/config.json")
                .unwrap()
                .as_deref(),
            Some(r#"{"updatedAt":123}"#)
        );
        assert_eq!(
            sync_read("dev1", "devices/dev1/missing.json").unwrap(),
            None
        );

        let listed = sync_list("dev1", Some("devices"), None).unwrap();
        let paths: Vec<String> = listed.into_iter().map(|e| e.rel_path).collect();
        assert!(paths.contains(&"devices/dev1/config.json".to_string()));
        assert!(paths.contains(&"devices/dev1/meta.json".to_string()));
        assert!(paths.contains(&"devices/dev1/snapshots/s1.json".to_string()));

        let request = serde_json::json!({ "cmd": "sync_list", "deviceId": "dev1",
            "expectedDir": status1.sync_dir.unwrap(), "relPrefix": "devices", "maxDepth": 1 });
        let result: serde_json::Value =
            serde_json::from_str(&crate::handle_request(&request.to_string())).unwrap();
        let files = result["files"].as_array().unwrap();
        assert_eq!(files.len(), 2);
        assert!(files
            .iter()
            .any(|f| f["relPath"] == "devices/dev1/meta.json"));

        assert!(sync_delete("dev1", "devices/dev1/snapshots/s1.json").unwrap());
        assert!(!sync_delete("dev1", "devices/dev1/snapshots/s1.json").unwrap());
        assert_eq!(
            sync_read("dev1", "devices/dev1/snapshots/s1.json").unwrap(),
            None
        );

        let disabled = set_sync_folder("dev1", None).unwrap();
        assert!(!disabled.enabled);

        env::remove_var("TAB_REAPER_HOST_CONFIG");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn concurrent_profile_updates_preserve_each_opt_out() {
        let _guard = ENV_LOCK.lock().unwrap();
        let base = env::temp_dir().join(format!(
            "tab-reaper-profiles-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        env::set_var("TAB_REAPER_HOST_CONFIG", base.join("host.json"));
        let folder = base.join("backup");
        let path = folder.to_str().unwrap();
        for i in 0..4 {
            set_sync_folder(&format!("old-{i}"), Some(path)).unwrap();
        }
        let start = std::sync::Barrier::new(8);
        std::thread::scope(|scope| {
            for i in 0..4 {
                let start = &start;
                scope.spawn(move || {
                    start.wait();
                    set_sync_folder(&format!("old-{i}"), None).unwrap();
                });
                scope.spawn(move || {
                    start.wait();
                    set_sync_folder(&format!("new-{i}"), Some(path)).unwrap();
                });
            }
        });
        let approved = read_host_config().unwrap().sync_dirs;
        assert_eq!(approved.len(), 4);
        for i in 0..4 {
            assert!(approved.contains_key(&format!("new-{i}")));
        }
        env::remove_var("TAB_REAPER_HOST_CONFIG");
        fs::remove_dir_all(base).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape_on_read_write_delete_and_list() {
        use std::os::unix::fs::symlink;

        let _guard = ENV_LOCK.lock().unwrap();
        let base = env::temp_dir().join(format!(
            "tab-reaper-symlink-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let cfg_file = base.join("host.json");
        let sync_dir = base.join("sync-root");
        let outside_dir = base.join("outside");
        fs::create_dir_all(&outside_dir).unwrap();
        fs::write(outside_dir.join("secret.json"), r#"{"secret":true}"#).unwrap();

        env::set_var("TAB_REAPER_HOST_CONFIG", &cfg_file);
        set_sync_folder("dev1", Some(sync_dir.to_str().unwrap())).unwrap();

        fs::create_dir_all(sync_dir.join("devices")).unwrap();
        symlink(&outside_dir, sync_dir.join("devices").join("dev1")).unwrap();

        assert!(sync_read("dev1", "devices/dev1/secret.json").is_err());
        assert!(sync_write("dev1", "devices/dev1/pwn.json", r#"{}"#).is_err());
        assert!(sync_delete("dev1", "devices/dev1/secret.json").is_err());

        let listed = sync_list("dev1", Some("devices"), None).unwrap();
        assert!(listed.is_empty());

        fs::rename(&sync_dir, base.join("original")).unwrap();
        symlink(&outside_dir, &sync_dir).unwrap();
        assert!(!get_sync_status(Some("dev1")).writable);

        env::remove_var("TAB_REAPER_HOST_CONFIG");
        let _ = fs::remove_dir_all(&base);
    }

    /// Approval proves the folder writable with a probe file. Status polls must not write to
    /// the folder, so a folder that turns read-only later fails on sync_write instead.
    #[cfg(unix)]
    #[test]
    fn probes_writability_on_approval_but_not_on_status_polls() {
        use std::os::unix::fs::PermissionsExt;

        let _guard = ENV_LOCK.lock().unwrap();
        let base = env::temp_dir().join(format!(
            "tab-reaper-readonly-test-{}-{}",
            std::process::id(),
            temp_nanos()
        ));
        let sync_dir = base.join("sync-root");
        env::set_var("TAB_REAPER_HOST_CONFIG", base.join("host.json"));

        set_sync_folder("dev1", Some(sync_dir.to_str().unwrap())).unwrap();
        fs::set_permissions(&sync_dir, fs::Permissions::from_mode(0o555)).unwrap();

        let status = get_sync_status(Some("dev1"));
        assert!(status.enabled);
        assert!(status.writable);
        assert!(sync_write("dev1", "devices/dev1/config.json", "{}").is_err());
        assert!(set_sync_folder("dev2", Some(sync_dir.to_str().unwrap())).is_err());

        fs::set_permissions(&sync_dir, fs::Permissions::from_mode(0o755)).unwrap();
        env::remove_var("TAB_REAPER_HOST_CONFIG");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn filters_preserved_cloud_storage_names_and_markers() {
        assert!(!is_preserved_cloud_storage_name("GoogleDrive-eu@marcusgrando.com"));
        assert!(!is_preserved_cloud_storage_name("OneDrive-Personal"));
        assert!(!is_preserved_cloud_storage_name("OneDrive-Company (Work)"));
        assert!(!is_preserved_cloud_storage_name("Dropbox"));
        assert!(!is_preserved_cloud_storage_name("GoogleDrive-user@example.com ()"));

        assert!(is_preserved_cloud_storage_name(
            "GoogleDrive-eu@marcusgrando.com (12-12-23 09:22)"
        ));
        assert!(is_preserved_cloud_storage_name(
            "GoogleDrive-marcus.grando@azion.com (08-08-24 09:29)"
        ));
        assert!(is_preserved_cloud_storage_name(
            "OneDrive-Personal (2024-08-08 09:29:15)"
        ));

        let base = env::temp_dir().join(format!(
            "tab-reaper-cloudstorage-test-{}-{}",
            std::process::id(),
            temp_nanos()
        ));
        let active = base.join("GoogleDrive-eu@marcusgrando.com");
        let preserved_by_name = base.join("GoogleDrive-eu@marcusgrando.com (2023-12-12)");
        let preserved_by_marker = base.join("GoogleDrive-marcus.grando@azion.com");
        fs::create_dir_all(&active).unwrap();
        fs::create_dir_all(&preserved_by_name).unwrap();
        fs::create_dir_all(&preserved_by_marker).unwrap();
        fs::write(
            preserved_by_marker.join(".drive_fs_ignore_preserved_domain"),
            b"",
        )
        .unwrap();

        assert!(!is_preserved_cloud_storage_dir(&active));
        assert!(is_preserved_cloud_storage_dir(&preserved_by_name));
        assert!(is_preserved_cloud_storage_dir(&preserved_by_marker));

        #[cfg(target_os = "macos")]
        assert!(!has_file_provider_domain_id(&active));

        let _ = fs::remove_dir_all(&base);
    }
}
