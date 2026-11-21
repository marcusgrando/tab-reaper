use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::path::Path;

const MAX_MESSAGE_LEN: usize = 1024 * 1024;
const HOST_VERSION: &str = env!("CARGO_PKG_VERSION");

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
    if payload.contains("\"ping\"") {
        return format!(
            "{{\"ok\":true,\"version\":\"{}\",\"platform\":\"{}\"}}",
            HOST_VERSION,
            env::consts::OS
        );
    }

    if payload.contains("\"chrome_memory\"") {
        return match collect_memory_report() {
            Ok(report) => format_memory_json(&report),
            Err(err) => format_error_json(&err),
        };
    }

    format_error_json("unknown command")
}

fn format_memory_json(r: &MemoryReport) -> String {
    format!(
        "{{\"ok\":true,\"chromeBytes\":{},\"processCount\":{},\"systemTotalBytes\":{},\"systemAvailableBytes\":{},\"metric\":\"{}\"}}",
        r.chrome_bytes, r.process_count, r.system_total_bytes, r.system_available_bytes, r.metric
    )
}

fn format_error_json(err: &str) -> String {
    let escaped = err.replace('\\', "\\\\").replace('"', "\\\"");
    format!("{{\"ok\":false,\"error\":\"{}\"}}", escaped)
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
        .args(["-axo", "rss=,comm="])
        .output()
        .map_err(|e| format!("failed to run ps: {}", e))?;
    if !ps_out.status.success() {
        return Err("ps command failed".to_string());
    }

    let (chrome_bytes, process_count) =
        parse_macos_ps_chrome(&String::from_utf8_lossy(&ps_out.stdout));

    Ok(MemoryReport {
        chrome_bytes,
        process_count,
        system_total_bytes,
        system_available_bytes,
        metric: "rss",
    })
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
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
fn parse_macos_ps_chrome(output: &str) -> (u64, usize) {
    let mut total_bytes: u64 = 0;
    let mut count: usize = 0;

    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let mut parts = trimmed.splitn(2, char::is_whitespace);
        let Some(rss_str) = parts.next() else {
            continue;
        };
        let Some(comm) = parts.next().map(str::trim) else {
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
            || lower.contains("brave browser");
        if is_chrome {
            total_bytes = total_bytes.saturating_add(rss_kb.saturating_mul(1024));
            count += 1;
        }
    }

    (total_bytes, count)
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
  250000 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n\
  180000 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/130/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)\n\
   12000 /Users/dev/.local/bin/tab-reaper-host\n\
   90000 /usr/bin/vim\n";
        assert_eq!(parse_macos_ps_chrome(ps), (430_000 * 1024, 2));
    }
}
