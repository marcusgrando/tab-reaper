mod sync;

use serde::Deserialize;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::env;
#[cfg(target_os = "linux")]
use std::fs;
use std::io::{self, Read, Write};
#[cfg(target_os = "linux")]
use std::path::Path;

const MAX_MESSAGE_LEN: usize = 2 * 1024 * 1024;
const HOST_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Deserialize)]
struct NativeRequest {
    cmd: String,
    #[serde(default, rename = "deviceId")]
    device_id: Option<String>,
    #[serde(default, rename = "targetDeviceId")]
    target_device_id: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default, rename = "expectedDir")]
    expected_dir: Option<String>,
    #[serde(default, rename = "relPath")]
    rel_path: Option<String>,
    #[serde(default, rename = "relPrefix")]
    rel_prefix: Option<String>,
    #[serde(default, rename = "maxDepth")]
    max_depth: Option<usize>,
    #[serde(default)]
    content: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
struct MemoryReport {
    chrome_bytes: u64,
    process_count: usize,
    system_total_bytes: u64,
    system_available_bytes: u64,
    metric: &'static str,
    renderers: HashMap<u32, u64>,
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.iter().any(|a| a == "--once") {
        match collect_memory_report() {
            Ok(report) => println!("{}", self_test_json(&report)),
            Err(err) => {
                eprintln!("{}", format_error_json(&err));
                std::process::exit(1);
            }
        }
        return;
    }

    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = stdin.lock();
    let mut writer = stdout.lock();

    while let Some(msg) = match read_native_message(&mut reader) {
        Ok(m) => m,
        Err(err) => {
            let _ = write_native_message(&mut writer, &format_error_json(&err));
            return;
        }
    } {
        let response = handle_request(&msg);
        if write_native_message(&mut writer, &response).is_err() {
            return;
        }
    }
}

fn handle_request(payload: &str) -> String {
    let req: NativeRequest = match serde_json::from_str(payload) {
        Ok(r) => r,
        Err(err) => return format_error_json(&format!("invalid request JSON: {err}")),
    };
    match dispatch_request(req) {
        Ok(value) => value.to_string(),
        Err(err) => format_error_json(&err),
    }
}

fn dispatch_request(req: NativeRequest) -> Result<serde_json::Value, String> {
    match req.cmd.as_str() {
        "ping" => {
            let status = sync::get_sync_status(req.device_id.as_deref());
            Ok(json!({
                "ok": true,
                "version": HOST_VERSION,
                "platform": env::consts::OS,
                "capabilities": ["chrome_memory", "tab_memory", "folder_sync", "expected_dir", "manage_devices"],
                "syncEnabled": status.enabled,
                "syncDir": status.sync_dir,
                "hostname": status.hostname,
            }))
        }
        "chrome_memory" => Ok(memory_report_json(&collect_memory_report()?)),
        "sync_detect_folders" => Ok(json!({
            "ok": true,
            "candidates": sync::detect_cloud_folders(),
            "hostname": sync::get_hostname(),
        })),
        "sync_pick_folder" => match sync::pick_folder_dialog()? {
            Some(path) => Ok(json!({ "ok": true, "path": path, "cancelled": false })),
            None => Ok(json!({ "ok": false, "cancelled": true })),
        },
        "sync_set_folder" => {
            let device_id = req.device_id.as_deref().ok_or("missing deviceId")?;
            let status = sync::set_sync_folder(device_id, req.path.as_deref())?;
            Ok(sync_status_json(status))
        }
        "sync_get_status" => Ok(sync_status_json(sync::get_sync_status(
            req.device_id.as_deref(),
        ))),
        "sync_write" => {
            let device_id = req.device_id.as_deref().ok_or("missing deviceId")?;
            let rel_path = req.rel_path.as_deref().ok_or("missing relPath")?;
            let content = req.content.as_deref().ok_or("missing content")?;
            let dest = sync::lock_destination(device_id, req.expected_dir.as_deref())?;
            let bytes = dest.write(rel_path, content, req.target_device_id.as_deref())?;
            Ok(json!({ "ok": true, "bytesWritten": bytes }))
        }
        "sync_read" => {
            let device_id = req.device_id.as_deref().ok_or("missing deviceId")?;
            let rel_path = req.rel_path.as_deref().ok_or("missing relPath")?;
            let dest = sync::lock_destination(device_id, req.expected_dir.as_deref())?;
            match dest.read(rel_path)? {
                Some(content) => Ok(json!({ "ok": true, "exists": true, "content": content })),
                None => Ok(json!({ "ok": true, "exists": false })),
            }
        }
        "sync_delete" => {
            let device_id = req.device_id.as_deref().ok_or("missing deviceId")?;
            let rel_path = req.rel_path.as_deref().ok_or("missing relPath")?;
            let dest = sync::lock_destination(device_id, req.expected_dir.as_deref())?;
            let deleted = dest.delete(rel_path, req.target_device_id.as_deref())?;
            Ok(json!({ "ok": true, "deleted": deleted }))
        }
        "sync_delete_device" => {
            let device_id = req.device_id.as_deref().ok_or("missing deviceId")?;
            let target_device_id = req
                .target_device_id
                .as_deref()
                .ok_or("missing targetDeviceId")?;
            let dest = sync::lock_destination(device_id, req.expected_dir.as_deref())?;
            let deleted = dest.delete_device(target_device_id)?;
            Ok(json!({ "ok": true, "deleted": deleted }))
        }
        "sync_list" => {
            let device_id = req.device_id.as_deref().ok_or("missing deviceId")?;
            let dest = sync::lock_destination(device_id, req.expected_dir.as_deref())?;
            let files = dest.list(req.rel_prefix.as_deref(), req.max_depth)?;
            Ok(json!({ "ok": true, "files": files }))
        }
        _ => Err("unknown command".to_string()),
    }
}

fn sync_status_json(status: sync::SyncStatus) -> serde_json::Value {
    json!({
        "ok": true,
        "enabled": status.enabled,
        "capabilities": ["folder_sync", "expected_dir", "manage_devices"],
        "version": HOST_VERSION,
        "syncDir": status.sync_dir,
        "writable": status.writable,
        "hostname": status.hostname,
    })
}

fn self_test_json(r: &MemoryReport) -> serde_json::Value {
    json!({
        "ok": true,
        "version": HOST_VERSION,
        "platform": env::consts::OS,
        "hostname": sync::get_hostname(),
        "systemTotalBytes": r.system_total_bytes,
        "systemAvailableBytes": r.system_available_bytes,
        "metric": r.metric,
    })
}

fn memory_report_json(r: &MemoryReport) -> serde_json::Value {
    let renderers: serde_json::Map<String, serde_json::Value> = r
        .renderers
        .iter()
        .map(|(id, &bytes)| (id.to_string(), json!(bytes)))
        .collect();
    json!({
        "ok": true,
        "chromeBytes": r.chrome_bytes,
        "processCount": r.process_count,
        "systemTotalBytes": r.system_total_bytes,
        "systemAvailableBytes": r.system_available_bytes,
        "metric": r.metric,
        "renderers": renderers,
    })
}

fn format_error_json(err: &str) -> String {
    json!({ "ok": false, "error": err }).to_string()
}

fn read_native_message<R: Read>(reader: &mut R) -> Result<Option<String>, String> {
    let mut len_buf = [0u8; 4];
    match reader.read_exact(&mut len_buf) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(format!("stdin read error: {}", e)),
    }

    let len = u32::from_le_bytes(len_buf) as usize;
    if len == 0 || len > MAX_MESSAGE_LEN {
        return Err(format!("invalid message length: {}", len));
    }

    let mut body = vec![0u8; len];
    reader
        .read_exact(&mut body)
        .map_err(|e| format!("stdin body error: {}", e))?;

    String::from_utf8(body)
        .map(Some)
        .map_err(|e| format!("invalid utf8: {}", e))
}

fn write_native_message<W: Write>(writer: &mut W, json: &str) -> io::Result<()> {
    let bytes = json.as_bytes();
    let len = (bytes.len() as u32).to_le_bytes();
    writer.write_all(&len)?;
    writer.write_all(bytes)?;
    writer.flush()
}

/// One process-table row: enough to walk from this host up to the browser that launched it.
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows", test))]
#[derive(Debug, Clone, Copy)]
struct ProcLink {
    pid: u32,
    ppid: u32,
    /// A shell the browser puts between itself and the host (`cmd.exe` on Windows).
    shell_launcher: bool,
}

/// Selects the processes of the browser that launched this host: the nearest ancestor that is
/// not a shell launcher, plus all of its descendants. The host and the launchers between it and
/// the browser are left out. Selecting by ancestry instead of by process name keeps other
/// browsers (Canary, Chrome for Testing, Brave) out of the sum. When that ancestor is not in
/// `rows` this fails instead of guessing, and the extension falls back to `chrome.system.memory`.
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows", test))]
fn browser_tree_pids(rows: &[ProcLink], self_pid: u32) -> Result<Vec<u32>, String> {
    let by_pid: HashMap<u32, &ProcLink> = rows.iter().map(|row| (row.pid, row)).collect();
    let host = by_pid
        .get(&self_pid)
        .ok_or("cannot determine the launching browser: host process not found")?;

    let mut excluded = HashSet::from([self_pid]);
    let mut root = host.ppid;
    loop {
        // pid 0 or 1 means the host was orphaned or started by the OS, not by a browser.
        if root <= 1 {
            return Err(
                "cannot determine the launching browser: host has no parent process".to_string(),
            );
        }
        let parent = by_pid.get(&root).ok_or_else(|| {
            format!("cannot determine the launching browser: parent process {root} not found")
        })?;
        if !parent.shell_launcher {
            break;
        }
        if !excluded.insert(root) {
            return Err("cannot determine the launching browser: parent process loop".to_string());
        }
        root = parent.ppid;
    }

    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for row in rows {
        children.entry(row.ppid).or_default().push(row.pid);
    }

    let mut tree = vec![root];
    let mut seen = HashSet::from([root]);
    let mut next = 0;
    while next < tree.len() {
        let pid = tree[next];
        next += 1;
        for &child in children.get(&pid).into_iter().flatten() {
            // Skipping an excluded pid also skips its subtree: the host and its launchers.
            if !excluded.contains(&child) && seen.insert(child) {
                tree.push(child);
            }
        }
    }
    Ok(tree)
}

/// Extracts Chromium's `--renderer-client-id=<N>` from a renderer process's argv.
/// Only `--type=renderer` processes match, so other helper types are ignored.
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows", test))]
fn parse_renderer_client_id<'a, I>(args: I) -> Option<u32>
where
    I: IntoIterator<Item = &'a str>,
{
    let mut is_renderer = false;
    let mut client_id = None;
    for arg in args {
        if arg == "--type=renderer" {
            is_renderer = true;
        } else if let Some(val) = arg.strip_prefix("--renderer-client-id=") {
            client_id = val.parse::<u32>().ok();
        }
    }
    if is_renderer {
        client_id
    } else {
        None
    }
}

/// Parses Linux `/proc/<pid>/cmdline`, handling both standard NUL-separated argv and
/// Chromium's Linux Zygote `SetProcessTitleFromCommandLine()` layout where all flags are
/// space-joined inside `argv[0]` followed by a trailing NUL.
#[cfg(any(target_os = "linux", test))]
fn parse_linux_cmdline_renderer_id(bytes: &[u8]) -> Option<u32> {
    let nul_parts: Vec<&str> = bytes
        .split(|&b| b == 0)
        .filter(|s| !s.is_empty())
        .filter_map(|s| std::str::from_utf8(s).ok())
        .collect();
    if nul_parts.len() == 1 {
        parse_renderer_client_id(nul_parts[0].split_ascii_whitespace())
    } else {
        parse_renderer_client_id(nul_parts)
    }
}

/// Parses XNU `KERN_PROCARGS2` (`[argc: i32][exec_path\0+][argv[0..argc]\0][envp...]`),
/// stopping after `argc` arguments so environment variables are never inspected.
#[cfg(any(target_os = "macos", test))]
fn parse_macos_procargs2_renderer_id(bytes: &[u8]) -> Option<u32> {
    if bytes.len() < 4 {
        return None;
    }
    let argc = i32::from_ne_bytes(bytes[..4].try_into().ok()?);
    if argc <= 0 {
        return None;
    }
    let mut i = 4usize;
    while i < bytes.len() && bytes[i] != 0 {
        i += 1;
    }
    while i < bytes.len() && bytes[i] == 0 {
        i += 1;
    }

    let mut args = Vec::with_capacity((argc as usize).min(256));
    for _ in 0..(argc as usize) {
        if i >= bytes.len() {
            break;
        }
        let start = i;
        while i < bytes.len() && bytes[i] != 0 {
            i += 1;
        }
        if let Ok(arg) = std::str::from_utf8(&bytes[start..i]) {
            args.push(arg);
        }
        if i < bytes.len() {
            i += 1;
        }
    }
    parse_renderer_client_id(args)
}

#[cfg(any(target_os = "windows", test))]
fn parse_windows_cmdline_renderer_id(cmdline: &str) -> Option<u32> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut has_token = false;
    let mut chars = cmdline.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\\' if in_quotes && chars.peek() == Some(&'"') => {
                current.push(chars.next().unwrap());
                has_token = true;
            }
            '"' => {
                in_quotes = !in_quotes;
                has_token = true;
            }
            c if c.is_whitespace() && !in_quotes => {
                if has_token {
                    args.push(std::mem::take(&mut current));
                    has_token = false;
                }
            }
            c => {
                current.push(c);
                has_token = true;
            }
        }
    }
    if has_token {
        args.push(current);
    }
    parse_renderer_client_id(args.iter().map(String::as_str))
}

#[cfg(target_os = "linux")]
fn read_renderer_client_id(proc_dir: &Path) -> Option<u32> {
    let bytes = fs::read(proc_dir.join("cmdline")).ok()?;
    parse_linux_cmdline_renderer_id(&bytes)
}

#[cfg(target_os = "linux")]
fn collect_memory_report() -> Result<MemoryReport, String> {
    let meminfo = fs::read_to_string("/proc/meminfo")
        .map_err(|e| format!("failed to read /proc/meminfo: {}", e))?;
    let (system_total_bytes, system_available_bytes) = parse_meminfo(&meminfo)?;
    let pids = browser_tree_pids(&linux_process_table()?, std::process::id())?;

    let mut chrome_bytes: u64 = 0;
    let mut process_count: usize = 0;
    let mut used_pss = false;
    let mut renderers: HashMap<u32, u64> = HashMap::new();
    let page_size = 4096u64;

    for pid in pids {
        let proc_dir = Path::new("/proc").join(pid.to_string());
        let mem_bytes = if let Some(pss) = read_pss_bytes(&proc_dir) {
            used_pss = true;
            Some(pss)
        } else {
            read_statm_rss_bytes(&proc_dir, page_size)
        };
        if let Some(bytes) = mem_bytes {
            chrome_bytes = chrome_bytes.saturating_add(bytes);
            process_count += 1;
            if let Some(client_id) = read_renderer_client_id(&proc_dir) {
                renderers
                    .entry(client_id)
                    .and_modify(|v| *v = v.saturating_add(bytes))
                    .or_insert(bytes);
            }
        }
    }

    Ok(MemoryReport {
        chrome_bytes,
        process_count,
        system_total_bytes,
        system_available_bytes,
        metric: if used_pss { "pss" } else { "rss" },
        renderers,
    })
}

#[cfg(target_os = "linux")]
fn linux_process_table() -> Result<Vec<ProcLink>, String> {
    let entries = fs::read_dir("/proc").map_err(|e| format!("failed to read /proc: {}", e))?;
    let mut rows = Vec::new();
    for entry in entries.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|s| s.parse::<u32>().ok())
        else {
            continue;
        };
        // A process that exits between listing and reading is skipped.
        let Ok(stat) = fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        if let Some(ppid) = parse_proc_stat_ppid(&stat) {
            rows.push(ProcLink {
                pid,
                ppid,
                shell_launcher: false,
            });
        }
    }
    Ok(rows)
}

#[cfg(any(target_os = "linux", test))]
fn parse_proc_stat_ppid(stat: &str) -> Option<u32> {
    // Field 2 (comm) is parenthesized and may itself contain spaces or ')'.
    let after_comm = &stat[stat.rfind(')')? + 1..];
    after_comm.split_whitespace().nth(1)?.parse().ok()
}

#[cfg(target_os = "macos")]
fn collect_memory_report() -> Result<MemoryReport, String> {
    let system_total_bytes = macos::memsize()?;
    let system_available_bytes = macos::available_bytes().unwrap_or(0);
    let pids = browser_tree_pids(&macos::process_table()?, std::process::id())?;

    let mut chrome_bytes: u64 = 0;
    let mut process_count: usize = 0;
    let mut renderers: HashMap<u32, u64> = HashMap::new();
    for pid in pids {
        // phys_footprint matches Activity Monitor (it includes compressed RAM and GPU/IOKit
        // allocations) and is often 2-3x the uncompressed RSS. A process that exited is skipped.
        if let Some(footprint) = macos::phys_footprint(pid) {
            chrome_bytes = chrome_bytes.saturating_add(footprint);
            process_count += 1;
            if let Some(client_id) = macos::renderer_client_id(pid) {
                renderers
                    .entry(client_id)
                    .and_modify(|v| *v = v.saturating_add(footprint))
                    .or_insert(footprint);
            }
        }
    }

    Ok(MemoryReport {
        chrome_bytes,
        process_count,
        system_total_bytes,
        system_available_bytes,
        metric: "phys_footprint",
        renderers,
    })
}

/// Direct libSystem calls. The host is spawned once per extension request, so shelling out to
/// `sysctl`, `vm_stat` and `ps` cost more than the measurement itself.
#[cfg(target_os = "macos")]
mod macos {
    use super::ProcLink;
    use std::ffi::{c_char, c_int, c_void};
    use std::mem::{size_of, zeroed};
    use std::ptr::null_mut;

    const CTL_KERN: c_int = 1;
    const KERN_PROCARGS2: c_int = 49;
    const MAX_PROCARGS_BYTES: usize = 2 * 1024 * 1024;
    const PROC_ALL_PIDS: u32 = 1;
    const PROC_PIDTBSDINFO: c_int = 3;
    const RUSAGE_INFO_V2: c_int = 2;
    const HOST_VM_INFO64: c_int = 4;
    const KERN_SUCCESS: c_int = 0;

    /// `struct proc_bsdinfo` from <sys/proc_info.h>.
    #[repr(C)]
    struct ProcBsdInfo {
        pbi_flags: u32,
        pbi_status: u32,
        pbi_xstatus: u32,
        pbi_pid: u32,
        pbi_ppid: u32,
        pbi_uid: u32,
        pbi_gid: u32,
        pbi_ruid: u32,
        pbi_rgid: u32,
        pbi_svuid: u32,
        pbi_svgid: u32,
        rfu_1: u32,
        pbi_comm: [c_char; 16],
        pbi_name: [c_char; 32],
        pbi_nfiles: u32,
        pbi_pgid: u32,
        pbi_pjobc: u32,
        e_tdev: u32,
        e_tpgid: u32,
        pbi_nice: i32,
        pbi_start_tvsec: u64,
        pbi_start_tvusec: u64,
    }

    /// `struct rusage_info_v2` from <sys/resource.h>.
    #[repr(C)]
    struct RusageInfoV2 {
        ri_uuid: [u8; 16],
        ri_user_time: u64,
        ri_system_time: u64,
        ri_pkg_idle_wkups: u64,
        ri_interrupt_wkups: u64,
        ri_pageins: u64,
        ri_wired_size: u64,
        ri_resident_size: u64,
        ri_phys_footprint: u64,
        ri_proc_start_abstime: u64,
        ri_proc_exit_abstime: u64,
        ri_child_user_time: u64,
        ri_child_system_time: u64,
        ri_child_pkg_idle_wkups: u64,
        ri_child_interrupt_wkups: u64,
        ri_child_pageins: u64,
        ri_child_elapsed_abstime: u64,
        ri_diskio_bytesread: u64,
        ri_diskio_byteswritten: u64,
    }

    /// `struct vm_statistics64` from <mach/vm_statistics.h> (HOST_VM_INFO64_REV1 layout).
    #[repr(C, align(8))]
    struct VmStatistics64 {
        free_count: u32,
        active_count: u32,
        inactive_count: u32,
        wire_count: u32,
        zero_fill_count: u64,
        reactivations: u64,
        pageins: u64,
        pageouts: u64,
        faults: u64,
        cow_faults: u64,
        lookups: u64,
        hits: u64,
        purges: u64,
        purgeable_count: u32,
        speculative_count: u32,
        decompressions: u64,
        compressions: u64,
        swapins: u64,
        swapouts: u64,
        compressor_page_count: u32,
        throttled_count: u32,
        external_page_count: u32,
        internal_page_count: u32,
        total_uncompressed_pages_in_compressor: u64,
    }

    extern "C" {
        fn sysctl(
            name: *mut c_int,
            namelen: u32,
            oldp: *mut c_void,
            oldlenp: *mut usize,
            newp: *mut c_void,
            newlen: usize,
        ) -> c_int;
        fn sysctlbyname(
            name: *const c_char,
            oldp: *mut c_void,
            oldlenp: *mut usize,
            newp: *mut c_void,
            newlen: usize,
        ) -> c_int;
        fn mach_host_self() -> u32;
        fn host_page_size(host: u32, page_size: *mut usize) -> c_int;
        fn host_statistics64(host: u32, flavor: c_int, info: *mut c_int, count: *mut u32) -> c_int;
        fn proc_listpids(kind: u32, typeinfo: u32, buffer: *mut c_void, buffersize: c_int)
            -> c_int;
        fn proc_pidinfo(
            pid: c_int,
            flavor: c_int,
            arg: u64,
            buffer: *mut c_void,
            buffersize: c_int,
        ) -> c_int;
        fn proc_pid_rusage(pid: c_int, flavor: c_int, buffer: *mut c_void) -> c_int;
    }

    pub fn memsize() -> Result<u64, String> {
        let mut value: u64 = 0;
        let mut len = size_of::<u64>();
        // SAFETY: the name is NUL-terminated and `len` is the size of the buffer `value`.
        let ret = unsafe {
            sysctlbyname(
                c"hw.memsize".as_ptr(),
                (&mut value as *mut u64).cast(),
                &mut len,
                null_mut(),
                0,
            )
        };
        if ret != 0 || len != size_of::<u64>() {
            return Err("sysctl hw.memsize failed".to_string());
        }
        Ok(value)
    }

    /// Free plus inactive pages, the same "available" figure `vm_stat` reported (its "Pages free"
    /// excludes speculative pages and lists them separately; the kernel's free_count includes them).
    pub fn available_bytes() -> Option<u64> {
        // SAFETY: `stats` is a vm_statistics64 and `count` is its size in integer_t units, as
        // host_statistics64 requires. host_page_size writes one vm_size_t.
        unsafe {
            let host = mach_host_self();
            let mut page_size: usize = 0;
            if host_page_size(host, &mut page_size) != KERN_SUCCESS {
                return None;
            }
            let mut stats: VmStatistics64 = zeroed();
            let mut count = (size_of::<VmStatistics64>() / size_of::<c_int>()) as u32;
            let ret = host_statistics64(
                host,
                HOST_VM_INFO64,
                (&mut stats as *mut VmStatistics64).cast(),
                &mut count,
            );
            if ret != KERN_SUCCESS {
                return None;
            }
            let pages = u64::from(stats.free_count) + u64::from(stats.inactive_count);
            Some(pages.saturating_mul(page_size as u64))
        }
    }

    pub fn process_table() -> Result<Vec<ProcLink>, String> {
        let pid_size = size_of::<c_int>();
        // SAFETY: a null buffer asks only for the required size. The second call writes at most
        // `buffersize` bytes into `pids`, and its return value is the number of bytes written.
        let pids = unsafe {
            let needed = proc_listpids(PROC_ALL_PIDS, 0, null_mut(), 0);
            if needed <= 0 {
                return Err("proc_listpids failed".to_string());
            }
            // Headroom for processes started between the two calls.
            let capacity = needed as usize / pid_size + 64;
            let mut pids: Vec<c_int> = vec![0; capacity];
            let written = proc_listpids(
                PROC_ALL_PIDS,
                0,
                pids.as_mut_ptr().cast(),
                (capacity * pid_size) as c_int,
            );
            if written <= 0 {
                return Err("proc_listpids failed".to_string());
            }
            pids.truncate(written as usize / pid_size);
            pids
        };

        let info_size = size_of::<ProcBsdInfo>() as c_int;
        let mut rows = Vec::with_capacity(pids.len());
        for pid in pids.into_iter().filter(|&pid| pid > 0) {
            // SAFETY: `info` is a proc_bsdinfo and `info_size` is its size.
            let mut info: ProcBsdInfo = unsafe { zeroed() };
            let written = unsafe {
                proc_pidinfo(
                    pid,
                    PROC_PIDTBSDINFO,
                    0,
                    (&mut info as *mut ProcBsdInfo).cast(),
                    info_size,
                )
            };
            // A process that exited or that we may not inspect is skipped.
            if written == info_size {
                rows.push(ProcLink {
                    pid: pid as u32,
                    ppid: info.pbi_ppid,
                    shell_launcher: false,
                });
            }
        }
        Ok(rows)
    }

    pub fn phys_footprint(pid: u32) -> Option<u64> {
        let pid = c_int::try_from(pid).ok()?;
        // SAFETY: `info` is a rusage_info_v2, the struct RUSAGE_INFO_V2 asks the kernel to fill.
        unsafe {
            let mut info: RusageInfoV2 = zeroed();
            if proc_pid_rusage(pid, RUSAGE_INFO_V2, (&mut info as *mut RusageInfoV2).cast()) == 0 {
                Some(info.ri_phys_footprint)
            } else {
                None
            }
        }
    }

    pub fn renderer_client_id(pid: u32) -> Option<u32> {
        let pid = c_int::try_from(pid).ok()?;
        let mut mib: [c_int; 3] = [CTL_KERN, KERN_PROCARGS2, pid];
        let mut size: usize = 0;
        // SAFETY: passing a null buffer asks the kernel only for the required size.
        if unsafe { sysctl(mib.as_mut_ptr(), 3, null_mut(), &mut size, null_mut(), 0) } != 0 {
            return None;
        }
        if size < 4 || size > MAX_PROCARGS_BYTES {
            return None;
        }
        let mut len = size.saturating_add(256).min(MAX_PROCARGS_BYTES);
        let mut buf = vec![0u8; len];
        // SAFETY: `buf` is valid for `len` bytes; sysctl writes at most `len` bytes and updates `len`.
        if unsafe { sysctl(mib.as_mut_ptr(), 3, buf.as_mut_ptr().cast(), &mut len, null_mut(), 0) }
            != 0
        {
            return None;
        }
        buf.truncate(len);
        super::parse_macos_procargs2_renderer_id(&buf)
    }
}

#[cfg(target_os = "windows")]
fn collect_memory_report() -> Result<MemoryReport, String> {
    use std::ffi::c_void;
    use std::mem::{align_of, size_of, zeroed};

    const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const INVALID_HANDLE_VALUE: isize = -1;
    const PROCESS_COMMAND_LINE_INFORMATION: u32 = 60;
    const STATUS_INFO_LENGTH_MISMATCH: i32 = 0xC000_0004_u32 as i32;
    const STATUS_BUFFER_OVERFLOW: i32 = 0x8000_0005_u32 as i32;
    const STATUS_BUFFER_TOO_SMALL: i32 = 0xC000_0023_u32 as i32;
    const MAX_CMDLINE_BYTES: usize = 2 * 1024 * 1024;

    #[repr(C)]
    struct MemoryStatusEx {
        dw_length: u32,
        dw_memory_load: u32,
        ull_total_phys: u64,
        ull_avail_phys: u64,
        ull_total_page_file: u64,
        ull_avail_page_file: u64,
        ull_total_virtual: u64,
        ull_avail_virtual: u64,
        ull_avail_extended_virtual: u64,
    }

    #[repr(C)]
    struct ProcessEntry32W {
        dw_size: u32,
        cnt_usage: u32,
        th32_process_id: u32,
        th32_default_heap_id: usize,
        th32_module_id: u32,
        cnt_threads: u32,
        th32_parent_process_id: u32,
        pc_pri_class_base: i32,
        dw_flags: u32,
        sz_exe_file: [u16; 260],
    }

    #[repr(C)]
    struct ProcessMemoryCountersEx {
        cb: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        working_set_size: usize,
        quota_peak_paged_pool_usage: usize,
        quota_paged_pool_usage: usize,
        quota_peak_non_paged_pool_usage: usize,
        quota_non_paged_pool_usage: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
        private_usage: usize,
    }

    #[repr(C)]
    #[allow(dead_code)]
    struct UnicodeString {
        length: u16,
        maximum_length: u16,
        buffer: *mut u16,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalMemoryStatusEx(lp_buffer: *mut MemoryStatusEx) -> i32;
        fn CreateToolhelp32Snapshot(dw_flags: u32, th32_process_id: u32) -> *mut c_void;
        fn Process32FirstW(h_snapshot: *mut c_void, lppe: *mut ProcessEntry32W) -> i32;
        fn Process32NextW(h_snapshot: *mut c_void, lppe: *mut ProcessEntry32W) -> i32;
        fn OpenProcess(
            dw_desired_access: u32,
            b_inherit_handle: i32,
            dw_process_id: u32,
        ) -> *mut c_void;
        fn CloseHandle(h_object: *mut c_void) -> i32;
        fn K32GetProcessMemoryInfo(
            process: *mut c_void,
            ppsmem_counters: *mut ProcessMemoryCountersEx,
            cb: u32,
        ) -> i32;
    }

    #[link(name = "ntdll")]
    extern "system" {
        fn NtQueryInformationProcess(
            process_handle: *mut c_void,
            process_information_class: u32,
            process_information: *mut c_void,
            process_information_length: u32,
            return_length: *mut u32,
        ) -> i32;
    }

    unsafe fn windows_renderer_client_id(proc_handle: *mut c_void) -> Option<u32> {
        let mut words = vec![0usize; 512]; // 4 KiB on 64-bit, pointer-aligned for UnicodeString.
        let mut ret_len: u32 = 0;
        let mut status = NtQueryInformationProcess(
            proc_handle,
            PROCESS_COMMAND_LINE_INFORMATION,
            words.as_mut_ptr().cast(),
            (words.len() * size_of::<usize>()) as u32,
            &mut ret_len,
        );
        if (status == STATUS_INFO_LENGTH_MISMATCH
            || status == STATUS_BUFFER_OVERFLOW
            || status == STATUS_BUFFER_TOO_SMALL)
            && (ret_len as usize) > words.len() * size_of::<usize>()
            && (ret_len as usize) <= MAX_CMDLINE_BYTES
        {
            let needed_words = (ret_len as usize).div_ceil(size_of::<usize>());
            words.resize(needed_words, 0);
            status = NtQueryInformationProcess(
                proc_handle,
                PROCESS_COMMAND_LINE_INFORMATION,
                words.as_mut_ptr().cast(),
                (words.len() * size_of::<usize>()) as u32,
                &mut ret_len,
            );
        }
        if status < 0 || words.len() * size_of::<usize>() < size_of::<UnicodeString>() {
            return None;
        }
        let buf_start = words.as_ptr() as usize;
        let buf_end = buf_start + words.len() * size_of::<usize>();
        let us = &*(words.as_ptr() as *const UnicodeString);
        let str_ptr = us.buffer as usize;
        let byte_len = us.length as usize;
        if us.buffer.is_null()
            || byte_len == 0
            || byte_len % 2 != 0
            || str_ptr % align_of::<u16>() != 0
            || str_ptr < buf_start
            || str_ptr.checked_add(byte_len).is_none_or(|end| end > buf_end)
        {
            return None;
        }
        let slice = std::slice::from_raw_parts(us.buffer, byte_len / 2);
        let cmdline = String::from_utf16_lossy(slice);
        parse_windows_cmdline_renderer_id(&cmdline)
    }

    unsafe {
        let mut mem_status: MemoryStatusEx = zeroed();
        mem_status.dw_length = size_of::<MemoryStatusEx>() as u32;
        if GlobalMemoryStatusEx(&mut mem_status) == 0 {
            return Err("GlobalMemoryStatusEx failed".to_string());
        }

        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot.is_null() || snapshot as isize == INVALID_HANDLE_VALUE {
            return Err("CreateToolhelp32Snapshot failed".to_string());
        }

        let mut entry: ProcessEntry32W = zeroed();
        entry.dw_size = size_of::<ProcessEntry32W>() as u32;
        let mut rows = Vec::new();
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                let nul_pos = entry
                    .sz_exe_file
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.sz_exe_file.len());
                let exe_name = String::from_utf16_lossy(&entry.sz_exe_file[..nul_pos]);
                rows.push(ProcLink {
                    pid: entry.th32_process_id,
                    ppid: entry.th32_parent_process_id,
                    // Chrome starts native hosts through `cmd.exe /d /s /c` to wire up stdio.
                    shell_launcher: exe_name.eq_ignore_ascii_case("cmd.exe"),
                });
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);

        let pids = browser_tree_pids(&rows, std::process::id())?;
        let mut chrome_bytes: u64 = 0;
        let mut process_count: usize = 0;
        let mut renderers: HashMap<u32, u64> = HashMap::new();
        for pid in pids {
            // A process that exited or that we may not open is skipped.
            let proc_handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if proc_handle.is_null() {
                continue;
            }
            let mut counters: ProcessMemoryCountersEx = zeroed();
            counters.cb = size_of::<ProcessMemoryCountersEx>() as u32;
            if K32GetProcessMemoryInfo(proc_handle, &mut counters, counters.cb) != 0 {
                chrome_bytes = chrome_bytes.saturating_add(counters.working_set_size as u64);
                process_count += 1;
                if let Some(client_id) = windows_renderer_client_id(proc_handle) {
                    // Use PrivateUsage per renderer so shared chrome.dll pages do not inflate every tab.
                    let renderer_bytes = if counters.private_usage > 0 {
                        counters.private_usage as u64
                    } else {
                        counters.working_set_size as u64
                    };
                    renderers
                        .entry(client_id)
                        .and_modify(|v| *v = v.saturating_add(renderer_bytes))
                        .or_insert(renderer_bytes);
                }
            }
            CloseHandle(proc_handle);
        }

        Ok(MemoryReport {
            chrome_bytes,
            process_count,
            system_total_bytes: mem_status.ull_total_phys,
            system_available_bytes: mem_status.ull_avail_phys,
            metric: "rss",
            renderers,
        })
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn collect_memory_report() -> Result<MemoryReport, String> {
    Err(format!("unsupported platform: {}", env::consts::OS))
}

#[cfg(target_os = "linux")]
fn read_pss_bytes(proc_dir: &Path) -> Option<u64> {
    let content = fs::read_to_string(proc_dir.join("smaps_rollup")).ok()?;
    parse_smaps_pss_bytes(&content)
}

#[cfg(target_os = "linux")]
fn read_statm_rss_bytes(proc_dir: &Path, page_size: u64) -> Option<u64> {
    let content = fs::read_to_string(proc_dir.join("statm")).ok()?;
    let rss_pages = content.split_whitespace().nth(1)?.parse::<u64>().ok()?;
    Some(rss_pages.saturating_mul(page_size))
}

#[cfg(any(target_os = "linux", test))]
fn parse_smaps_pss_bytes(content: &str) -> Option<u64> {
    for line in content.lines() {
        if let Some(rest) = line.strip_prefix("Pss:") {
            let kb = rest.split_whitespace().next()?.parse::<u64>().ok()?;
            return Some(kb.saturating_mul(1024));
        }
    }
    None
}

#[cfg(any(target_os = "linux", test))]
fn parse_meminfo(content: &str) -> Result<(u64, u64), String> {
    let mut total_kb: Option<u64> = None;
    let mut avail_kb: Option<u64> = None;

    for line in content.lines() {
        if let Some(rest) = line.strip_prefix("MemTotal:") {
            total_kb = rest.split_whitespace().next().and_then(|v| v.parse().ok());
        } else if let Some(rest) = line.strip_prefix("MemAvailable:") {
            avail_kb = rest.split_whitespace().next().and_then(|v| v.parse().ok());
        }
    }

    let total = total_kb
        .ok_or_else(|| "MemTotal missing in /proc/meminfo".to_string())?
        .saturating_mul(1024);
    let avail = avail_kb.unwrap_or(0).saturating_mul(1024);
    Ok((total, avail))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn roundtrip_native_message_framing() {
        let mut buf = Vec::new();
        let payload = r#"{"cmd":"ping"}"#;
        write_native_message(&mut buf, payload).unwrap();

        let mut cursor = Cursor::new(buf);
        let decoded = read_native_message(&mut cursor).unwrap();
        assert_eq!(decoded.as_deref(), Some(payload));
        assert_eq!(read_native_message(&mut cursor).unwrap(), None);
    }

    #[test]
    fn parses_smaps_rollup_pss() {
        let sample = "00400000-7fff0000 ---p 00000000 00:00 0 [rollup]\nRss:              120000 kB\nPss:               85432 kB\n";
        assert_eq!(parse_smaps_pss_bytes(sample), Some(85432 * 1024));
    }

    #[test]
    fn parses_proc_meminfo() {
        let sample = "MemTotal:       32768000 kB\nMemFree:         2000000 kB\nMemAvailable:   16384000 kB\n";
        assert_eq!(
            parse_meminfo(sample).unwrap(),
            (32_768_000 * 1024, 16_384_000 * 1024)
        );
    }

    #[test]
    fn handles_ping_command() {
        let resp = handle_request(r#"{"cmd":"ping"}"#);
        assert!(resp.contains(r#""ok":true"#));
        assert!(resp.contains(HOST_VERSION));
        assert!(resp.contains(r#""tab_memory""#));
    }

    #[test]
    fn parses_linux_cmdline_renderer_client_id() {
        let renderer = b"/opt/google/chrome/chrome\0--type=renderer\0--renderer-client-id=42\0--lang=en-US\0";
        assert_eq!(parse_linux_cmdline_renderer_id(renderer), Some(42));

        // Chromium's Linux Zygote overwrites argv[0] with space-joined flags and one trailing NUL.
        let zygote_renderer = b"/opt/google/chrome/chrome --type=renderer --user-data-dir=/home/u/My Profile --renderer-client-id=19 --lang=en-US\0";
        assert_eq!(parse_linux_cmdline_renderer_id(zygote_renderer), Some(19));

        let gpu = b"/opt/google/chrome/chrome --type=gpu-process --renderer-client-id=42\0";
        assert_eq!(parse_linux_cmdline_renderer_id(gpu), None);

        let invalid = b"/opt/google/chrome/chrome\0--type=renderer\0--renderer-client-id=abc\0";
        assert_eq!(parse_linux_cmdline_renderer_id(invalid), None);
    }

    #[test]
    fn parses_macos_procargs2_without_reading_envp() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&3i32.to_ne_bytes()); // argc = 3
        buf.extend_from_slice(b"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper (Renderer)\0\0\0");
        buf.extend_from_slice(b"Google Chrome Helper (Renderer)\0--type=renderer\0--renderer-client-id=17\0");
        buf.extend_from_slice(b"FAKE_ENV=1\0--renderer-client-id=999\0");
        assert_eq!(parse_macos_procargs2_renderer_id(&buf), Some(17));

        // Decoy flags in envp must never match a non-renderer process.
        let mut decoy = Vec::new();
        decoy.extend_from_slice(&2i32.to_ne_bytes()); // argc = 2
        decoy.extend_from_slice(b"/usr/bin/chrome\0\0");
        decoy.extend_from_slice(b"chrome\0--type=utility\0");
        decoy.extend_from_slice(b"--type=renderer\0--renderer-client-id=88\0");
        assert_eq!(parse_macos_procargs2_renderer_id(&decoy), None);
    }

    #[test]
    fn parses_windows_cmdline_renderer_client_id() {
        let cmd = r#""C:\Program Files\Google\Chrome\Application\chrome.exe" --type=renderer --renderer-client-id=91 --lang=en-US"#;
        assert_eq!(parse_windows_cmdline_renderer_id(cmd), Some(91));

        let quoted_decoy = r#""C:\Program Files\Google\Chrome\Application\chrome.exe" --flag="--type=renderer --renderer-client-id=91""#;
        assert_eq!(parse_windows_cmdline_renderer_id(quoted_decoy), None);

        let browser = r#""C:\Program Files\Google\Chrome\Application\chrome.exe" --profile-directory=Default"#;
        assert_eq!(parse_windows_cmdline_renderer_id(browser), None);
    }

    #[test]
    fn memory_report_json_includes_renderers_map() {
        let mut renderers = HashMap::new();
        renderers.insert(9, 292_552_704);
        let report = MemoryReport {
            chrome_bytes: 1_000_000_000,
            process_count: 10,
            system_total_bytes: 16_000_000_000,
            system_available_bytes: 8_000_000_000,
            metric: "pss",
            renderers,
        };
        let encoded = memory_report_json(&report);
        assert_eq!(encoded["renderers"]["9"], json!(292_552_704));
    }

    fn row(pid: u32, ppid: u32) -> ProcLink {
        ProcLink {
            pid,
            ppid,
            shell_launcher: false,
        }
    }

    fn sorted(mut pids: Vec<u32>) -> Vec<u32> {
        pids.sort_unstable();
        pids
    }

    #[test]
    fn browser_tree_is_the_host_parent_and_its_descendants() {
        let rows = [
            row(1, 0),
            row(100, 1), // browser that launched the host
            row(101, 100),
            row(102, 100), // zygote
            row(103, 102),
            row(104, 103), // renderer under the zygote
            row(500, 100), // this host
            row(300, 1),   // another browser (Canary, Brave, Playwright)
            row(301, 300),
        ];
        assert_eq!(
            sorted(browser_tree_pids(&rows, 500).unwrap()),
            vec![100, 101, 102, 103, 104]
        );
    }

    #[test]
    fn browser_tree_excludes_the_host_and_its_children() {
        let rows = [row(100, 1), row(500, 100), row(501, 500)];
        assert_eq!(browser_tree_pids(&rows, 500).unwrap(), vec![100]);
    }

    #[test]
    fn browser_tree_walks_past_the_windows_cmd_launcher() {
        let rows = [
            row(10, 4),
            row(11, 10),
            ProcLink {
                pid: 20,
                ppid: 10,
                shell_launcher: true,
            },
            row(30, 20),
            row(40, 4),
        ];
        assert_eq!(sorted(browser_tree_pids(&rows, 30).unwrap()), vec![10, 11]);
    }

    #[test]
    fn browser_tree_fails_when_the_launcher_is_unknown() {
        let missing_parent = [row(500, 999), row(100, 1)];
        assert!(browser_tree_pids(&missing_parent, 500).is_err());

        let orphaned = [row(1, 0), row(500, 1), row(100, 1)];
        assert!(browser_tree_pids(&orphaned, 500).is_err());

        let host_missing = [row(100, 1)];
        assert!(browser_tree_pids(&host_missing, 500).is_err());

        let launcher_loop = [
            ProcLink {
                pid: 20,
                ppid: 21,
                shell_launcher: true,
            },
            ProcLink {
                pid: 21,
                ppid: 20,
                shell_launcher: true,
            },
            row(500, 20),
        ];
        assert!(browser_tree_pids(&launcher_loop, 500).is_err());
    }

    #[test]
    fn parses_ppid_from_proc_stat() {
        assert_eq!(
            parse_proc_stat_ppid("4242 (chrome) S 4100 4242 4242 0 -1"),
            Some(4100)
        );
        assert_eq!(
            parse_proc_stat_ppid("4243 (Web Content) (x)) R 7 4243 4243 0 -1"),
            Some(7)
        );
        assert_eq!(parse_proc_stat_ppid("garbage"), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_reports_memory_from_system_calls() {
        assert!(macos::memsize().unwrap() > 0);
        assert!(macos::available_bytes().unwrap() > 0);
        let table = macos::process_table().unwrap();
        let me = table.iter().find(|r| r.pid == std::process::id()).unwrap();
        assert_eq!(me.ppid, std::os::unix::process::parent_id());
        assert!(macos::phys_footprint(std::process::id()).unwrap() > 0);
    }
}
