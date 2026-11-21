mod sync;

use serde::Deserialize;
use serde_json::json;
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
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.iter().any(|a| a == "--once") {
        match collect_memory_report() {
            Ok(report) => println!("{}", format_memory_json(&report)),
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

    let _destination = match req.cmd.as_str() {
        "sync_read" | "sync_write" | "sync_list" | "sync_delete" => {
            match sync::lock_destination(req.device_id.as_deref().unwrap_or(""), req.expected_dir.as_deref()) {
                Ok(lock) => Some(lock),
                Err(err) => return format_error_json(&err),
            }
        }
        _ => None,
    };

    match req.cmd.as_str() {
        "ping" => {
            let status = sync::get_sync_status(req.device_id.as_deref());
            json!({
                "ok": true,
                "version": HOST_VERSION,
                "platform": env::consts::OS,
                "capabilities": ["chrome_memory", "folder_sync", "expected_dir"],
                "syncEnabled": status.enabled,
                "syncDir": status.sync_dir,
                "hostname": status.hostname,
            })
            .to_string()
        }
        "chrome_memory" => match collect_memory_report() {
            Ok(report) => format_memory_json(&report),
            Err(err) => format_error_json(&err),
        },
        "sync_detect_folders" => {
            let candidates = sync::detect_cloud_folders();
            json!({
                "ok": true,
                "candidates": candidates,
                "hostname": sync::get_hostname(),
            })
            .to_string()
        }
        "sync_pick_folder" => match sync::pick_folder_dialog() {
            Ok(Some(path)) => json!({ "ok": true, "path": path, "cancelled": false }).to_string(),
            Ok(None) => json!({ "ok": false, "cancelled": true }).to_string(),
            Err(err) => format_error_json(&err),
        },
        "sync_set_folder" => {
            let Some(device_id) = req.device_id.as_deref() else {
                return format_error_json("missing deviceId");
            };
            match sync::set_sync_folder(device_id, req.path.as_deref()) {
                Ok(status) => json!({
                    "ok": true,
                    "enabled": status.enabled,
                    "capabilities": ["folder_sync", "expected_dir"],
                    "version": HOST_VERSION,
                    "syncDir": status.sync_dir,
                    "writable": status.writable,
                    "hostname": status.hostname,
                })
                .to_string(),
                Err(err) => format_error_json(&err),
            }
        }
        "sync_get_status" => {
            let status = sync::get_sync_status(req.device_id.as_deref());
            json!({
                "ok": true,
                "enabled": status.enabled,
                "capabilities": ["folder_sync", "expected_dir"],
                "version": HOST_VERSION,
                "syncDir": status.sync_dir,
                "writable": status.writable,
                "hostname": status.hostname,
            })
            .to_string()
        }
        "sync_write" => {
            let Some(device_id) = req.device_id.as_deref() else {
                return format_error_json("missing deviceId");
            };
            let Some(rel_path) = req.rel_path.as_deref() else {
                return format_error_json("missing relPath");
            };
            let Some(content) = req.content.as_deref() else {
                return format_error_json("missing content");
            };
            match sync::sync_write(device_id, rel_path, content) {
                Ok(bytes) => json!({ "ok": true, "bytesWritten": bytes }).to_string(),
                Err(err) => format_error_json(&err),
            }
        }
        "sync_read" => {
            let Some(device_id) = req.device_id.as_deref() else {
                return format_error_json("missing deviceId");
            };
            let Some(rel_path) = req.rel_path.as_deref() else {
                return format_error_json("missing relPath");
            };
            match sync::sync_read(device_id, rel_path) {
                Ok(Some(content)) => json!({ "ok": true, "exists": true, "content": content }).to_string(),
                Ok(None) => json!({ "ok": true, "exists": false }).to_string(),
                Err(err) => format_error_json(&err),
            }
        }
        "sync_delete" => {
            let Some(device_id) = req.device_id.as_deref() else {
                return format_error_json("missing deviceId");
            };
            let Some(rel_path) = req.rel_path.as_deref() else {
                return format_error_json("missing relPath");
            };
            match sync::sync_delete(device_id, rel_path) {
                Ok(deleted) => json!({ "ok": true, "deleted": deleted }).to_string(),
                Err(err) => format_error_json(&err),
            }
        }
        "sync_list" => {
            let Some(device_id) = req.device_id.as_deref() else {
                return format_error_json("missing deviceId");
            };
            match sync::sync_list(device_id, req.rel_prefix.as_deref(), req.max_depth) {
                Ok(files) => json!({ "ok": true, "files": files }).to_string(),
                Err(err) => format_error_json(&err),
            }
        }
        _ => format_error_json("unknown command"),
    }
}

fn format_memory_json(r: &MemoryReport) -> String {
    json!({
        "ok": true,
        "chromeBytes": r.chrome_bytes,
        "processCount": r.process_count,
        "systemTotalBytes": r.system_total_bytes,
        "systemAvailableBytes": r.system_available_bytes,
        "metric": r.metric,
    })
    .to_string()
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

#[cfg(target_os = "linux")]
fn collect_memory_report() -> Result<MemoryReport, String> {
    let meminfo = fs::read_to_string("/proc/meminfo")
        .map_err(|e| format!("failed to read /proc/meminfo: {}", e))?;
    let (system_total_bytes, system_available_bytes) = parse_meminfo(&meminfo)?;

    let mut chrome_bytes: u64 = 0;
    let mut process_count: usize = 0;
    let mut used_pss = false;
    let page_size = 4096u64;

    let entries = fs::read_dir("/proc").map_err(|e| format!("failed to read /proc: {}", e))?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(pid_str) = name.to_str() else {
            continue;
        };
        if !pid_str.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }

        let proc_dir = entry.path();
        if !is_chrome_process(&proc_dir) {
            continue;
        }

        if let Some(pss) = read_pss_bytes(&proc_dir) {
            chrome_bytes = chrome_bytes.saturating_add(pss);
            process_count += 1;
            used_pss = true;
        } else if let Some(rss) = read_statm_rss_bytes(&proc_dir, page_size) {
            chrome_bytes = chrome_bytes.saturating_add(rss);
            process_count += 1;
        }
    }

    Ok(MemoryReport {
        chrome_bytes,
        process_count,
        system_total_bytes,
        system_available_bytes,
        metric: if used_pss { "pss" } else { "rss" },
    })
}

#[cfg(target_os = "macos")]
fn collect_memory_report() -> Result<MemoryReport, String> {
    use std::process::Command;

    let memsize_out = Command::new("sysctl")
        .args(["-n", "hw.memsize"])
        .output()
        .map_err(|e| format!("failed to run sysctl: {}", e))?;
    if !memsize_out.status.success() {
        return Err("sysctl hw.memsize failed".to_string());
    }
    let system_total_bytes = String::from_utf8_lossy(&memsize_out.stdout)
        .trim()
        .parse::<u64>()
        .map_err(|e| format!("invalid hw.memsize: {}", e))?;

    let vm_stat_out = Command::new("vm_stat")
        .output()
        .map_err(|e| format!("failed to run vm_stat: {}", e))?;
    let system_available_bytes = if vm_stat_out.status.success() {
        parse_macos_vm_stat(&String::from_utf8_lossy(&vm_stat_out.stdout)).unwrap_or(0)
    } else {
        0
    };

    let ps_out = Command::new("ps")
        .args(["-axo", "pid=,rss=,comm="])
        .output()
        .map_err(|e| format!("failed to run ps: {}", e))?;
    if !ps_out.status.success() {
        return Err("ps command failed".to_string());
    }

    let procs = parse_macos_ps_chrome(&String::from_utf8_lossy(&ps_out.stdout));
    let mut chrome_bytes: u64 = 0;
    let mut used_footprint = false;

    for &(pid, rss_bytes) in &procs {
        // macOS Activity Monitor reports phys_footprint (includes compressed RAM and GPU/IOKit
        // allocations), which is often 2-3x higher than uncompressed RSS from `ps`.
        if let Some(fp) = read_macos_phys_footprint(pid) {
            chrome_bytes = chrome_bytes.saturating_add(fp);
            used_footprint = true;
        } else {
            chrome_bytes = chrome_bytes.saturating_add(rss_bytes);
        }
    }

    Ok(MemoryReport {
        chrome_bytes,
        process_count: procs.len(),
        system_total_bytes,
        system_available_bytes,
        metric: if used_footprint { "phys_footprint" } else { "rss" },
    })
}

#[cfg(target_os = "macos")]
fn read_macos_phys_footprint(pid: i32) -> Option<u64> {
    use std::ffi::c_void;
    use std::mem::zeroed;

    const RUSAGE_INFO_V2: i32 = 2;

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

    extern "C" {
        fn proc_pid_rusage(pid: i32, flavor: i32, buffer: *mut c_void) -> i32;
    }

    unsafe {
        let mut info: RusageInfoV2 = zeroed();
        let ret = proc_pid_rusage(pid, RUSAGE_INFO_V2, (&mut info as *mut RusageInfoV2).cast());
        if ret == 0 {
            Some(info.ri_phys_footprint)
        } else {
            None
        }
    }
}

#[cfg(target_os = "windows")]
fn collect_memory_report() -> Result<MemoryReport, String> {
    use std::ffi::c_void;
    use std::mem::{size_of, zeroed};

    const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const INVALID_HANDLE_VALUE: isize = -1;

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
    struct ProcessMemoryCounters {
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
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalMemoryStatusEx(lp_buffer: *mut MemoryStatusEx) -> i32;
        fn CreateToolhelp32Snapshot(dw_flags: u32, th32_process_id: u32) -> *mut c_void;
        fn Process32FirstW(h_snapshot: *mut c_void, lppe: *mut ProcessEntry32W) -> i32;
        fn Process32NextW(h_snapshot: *mut c_void, lppe: *mut ProcessEntry32W) -> i32;
        fn OpenProcess(dw_desired_access: u32, b_inherit_handle: i32, dw_process_id: u32) -> *mut c_void;
        fn CloseHandle(h_object: *mut c_void) -> i32;
        fn K32GetProcessMemoryInfo(
            process: *mut c_void,
            ppsmem_counters: *mut ProcessMemoryCounters,
            cb: u32,
        ) -> i32;
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

        let mut chrome_bytes: u64 = 0;
        let mut process_count: usize = 0;

        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                let nul_pos = entry
                    .sz_exe_file
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.sz_exe_file.len());
                let exe_name = String::from_utf16_lossy(&entry.sz_exe_file[..nul_pos]);

                if is_windows_chrome_exe(&exe_name) {
                    let proc_handle =
                        OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, entry.th32_process_id);
                    if !proc_handle.is_null() {
                        let mut counters: ProcessMemoryCounters = zeroed();
                        counters.cb = size_of::<ProcessMemoryCounters>() as u32;
                        if K32GetProcessMemoryInfo(proc_handle, &mut counters, counters.cb) != 0 {
                            chrome_bytes =
                                chrome_bytes.saturating_add(counters.working_set_size as u64);
                            process_count += 1;
                        }
                        CloseHandle(proc_handle);
                    }
                }

                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }

        CloseHandle(snapshot);

        Ok(MemoryReport {
            chrome_bytes,
            process_count,
            system_total_bytes: mem_status.ull_total_phys,
            system_available_bytes: mem_status.ull_avail_phys,
            metric: "rss",
        })
    }
}

#[cfg(any(target_os = "windows", test))]
fn is_windows_chrome_exe(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    matches!(lower.as_str(), "chrome.exe" | "chromium.exe" | "brave.exe")
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn collect_memory_report() -> Result<MemoryReport, String> {
    Err(format!("unsupported platform: {}", env::consts::OS))
}

#[cfg(any(target_os = "macos", test))]
fn parse_macos_vm_stat(output: &str) -> Option<u64> {
    let mut page_size: u64 = 4096;
    let mut available_pages: u64 = 0;

    for line in output.lines() {
        if let Some(idx) = line.find("page size of ") {
            let rest = &line[idx + "page size of ".len()..];
            if let Some(num) = rest.split_whitespace().next().and_then(|s| s.parse::<u64>().ok()) {
                page_size = num;
            }
            continue;
        }
        for prefix in ["Pages free:", "Pages inactive:", "Pages speculative:"] {
            if let Some(rest) = line.strip_prefix(prefix) {
                let cleaned = rest.trim().trim_end_matches('.');
                if let Ok(pages) = cleaned.parse::<u64>() {
                    available_pages = available_pages.saturating_add(pages);
                }
            }
        }
    }

    Some(available_pages.saturating_mul(page_size))
}

#[cfg(any(target_os = "macos", test))]
fn parse_macos_ps_chrome(output: &str) -> Vec<(i32, u64)> {
    let mut procs = Vec::new();

    for line in output.lines() {
        let trimmed = line.trim_start();
        let Some((pid_str, after_pid)) = trimmed.split_once(char::is_whitespace) else {
            continue;
        };
        let Some((rss_str, after_rss)) = after_pid.trim_start().split_once(char::is_whitespace) else {
            continue;
        };
        let comm = after_rss.trim();
        let Ok(pid) = pid_str.parse::<i32>() else {
            continue;
        };
        let Ok(rss_kb) = rss_str.parse::<u64>() else {
            continue;
        };

        let lower = comm.to_ascii_lowercase();
        if lower.contains("tab-reaper-host") {
            continue;
        }
        let is_chrome = lower.contains("google chrome")
            || lower.contains("chromium")
            || lower.contains("brave browser")
            || lower.contains("chrome apps.localized");
        if is_chrome {
            procs.push((pid, rss_kb.saturating_mul(1024)));
        }
    }

    procs
}

#[cfg(target_os = "linux")]
fn is_chrome_process(proc_dir: &Path) -> bool {
    let Ok(cmdline_bytes) = fs::read(proc_dir.join("cmdline")) else {
        return false;
    };
    if cmdline_bytes.is_empty() {
        return false;
    }

    let first_arg = cmdline_bytes
        .split(|&b| b == 0)
        .next()
        .and_then(|s| std::str::from_utf8(s).ok())
        .unwrap_or("");

    let exe_name = Path::new(first_arg)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    matches!(
        exe_name.as_str(),
        "chrome" | "google-chrome" | "chromium" | "chromium-browser" | "brave"
    )
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
    }

    #[test]
    fn parses_macos_vm_stat_and_ps() {
        let vm = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                               1000.\nPages active:                             5000.\nPages inactive:                           2000.\nPages speculative:                         500.\n";
        assert_eq!(parse_macos_vm_stat(vm), Some(3500 * 16384));

        let ps = "\
 5061 250000 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n\
 5284 180000 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/130/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)\n\
 9999  12000 /Users/dev/.local/bin/tab-reaper-host\n\
 1234  90000 /usr/bin/vim\n";
        assert_eq!(
            parse_macos_ps_chrome(ps),
            vec![(5061, 250_000 * 1024), (5284, 180_000 * 1024)]
        );
    }

    #[test]
    fn matches_windows_chrome_executables() {
        assert!(is_windows_chrome_exe("chrome.exe"));
        assert!(is_windows_chrome_exe("Chrome.EXE"));
        assert!(is_windows_chrome_exe("brave.exe"));
        assert!(is_windows_chrome_exe("chromium.exe"));
        assert!(!is_windows_chrome_exe("tab-reaper-host.exe"));
        assert!(!is_windows_chrome_exe("notepad.exe"));
    }
}
