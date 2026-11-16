//! `remote-audit.jsonl`: one line per phone action with its outcome, so the
//! desktop can show what paired phones did. Queries (reads) and tab
//! selection are not recorded. The file is bounded: past [`MAX_BYTES`] it
//! is rotated to `remote-audit.1.jsonl`, replacing the previous rotation.

use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use serde::{Deserialize, Serialize};

pub const FILE: &str = "remote-audit.jsonl";
pub const MAX_BYTES: u64 = 512 * 1024;
/// The most entries `recent` hands to the Settings page.
pub const MAX_LIST: usize = 200;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// Unix seconds.
    pub at: u64,
    pub device_id: String,
    pub device_name: String,
    pub kind: String,
    pub tab_id: String,
    pub ok: bool,
    pub error: Option<String>,
}

pub struct AuditLog {
    path: PathBuf,
    rotated: PathBuf,
    max_bytes: u64,
    /// One writer at a time: rotation and append must not interleave.
    write: Mutex<()>,
}

impl AuditLog {
    pub fn new(dir: &Path) -> Self {
        Self::with_limit(dir, MAX_BYTES)
    }

    pub fn with_limit(dir: &Path, max_bytes: u64) -> Self {
        Self {
            path: dir.join(FILE),
            rotated: dir.join("remote-audit.1.jsonl"),
            max_bytes,
            write: Mutex::new(()),
        }
    }

    /// Append one entry. Failures are logged, never raised: the audit must
    /// not change whether a phone's request succeeds.
    pub fn record(&self, entry: &Entry) {
        if let Err(error) = self.append(entry) {
            eprintln!("[omp-desktop] could not write the remote audit log: {error}");
        }
    }

    fn append(&self, entry: &Entry) -> Result<(), String> {
        let _one = self.write.lock().unwrap_or_else(PoisonError::into_inner);
        let mut line = serde_json::to_string(entry).map_err(|error| error.to_string())?;
        line.push('\n');
        let size = fs::metadata(&self.path).map_or(0, |meta| meta.len());
        if size > 0 && size + line.len() as u64 > self.max_bytes {
            fs::rename(&self.path, &self.rotated).map_err(|error| error.to_string())?;
        }
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|error| error.to_string())?;
        file.write_all(line.as_bytes())
            .map_err(|error| error.to_string())
    }

    /// The newest entries first, at most `limit` (capped at [`MAX_LIST`]),
    /// from the current file and then the rotated one. Unreadable lines are
    /// skipped.
    pub fn recent(&self, limit: usize) -> Vec<Entry> {
        let limit = limit.min(MAX_LIST);
        let _one = self.write.lock().unwrap_or_else(PoisonError::into_inner);
        let mut out = Vec::new();
        for path in [&self.path, &self.rotated] {
            let mut lines = read_entries(path);
            lines.reverse();
            out.extend(lines.into_iter().take(limit - out.len()));
            if out.len() >= limit {
                break;
            }
        }
        out
    }
}

fn read_entries(path: &Path) -> Vec<Entry> {
    let Ok(file) = fs::File::open(path) else {
        return Vec::new();
    };
    BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| serde_json::from_str(&line).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(n: u64) -> Entry {
        Entry {
            at: n,
            device_id: "d".into(),
            device_name: "iPhone".into(),
            kind: "prompt".into(),
            tab_id: "t".into(),
            ok: true,
            error: None,
        }
    }

    #[test]
    fn recent_lists_newest_first_and_caps_the_count() {
        let dir = crate::test_support::tempdir("remote-audit", "recent");
        let log = AuditLog::new(&dir);
        assert!(log.recent(10).is_empty(), "no file yet");
        for n in 0..5 {
            log.record(&entry(n));
        }
        let got = log.recent(3);
        assert_eq!(got, vec![entry(4), entry(3), entry(2)]);
        assert_eq!(log.recent(usize::MAX).len(), 5);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rotation_bounds_the_files_and_keeps_the_previous_entries_readable() {
        let dir = crate::test_support::tempdir("remote-audit", "rotate");
        let line = serde_json::to_string(&entry(0)).unwrap().len() as u64 + 1;
        // Room for three lines per file.
        let log = AuditLog::with_limit(&dir, line * 3);
        for n in 0..8 {
            log.record(&entry(n));
        }
        let current = std::fs::metadata(dir.join(FILE)).unwrap().len();
        assert!(current <= line * 3, "current file stays under the limit");
        let rotated = std::fs::metadata(dir.join("remote-audit.1.jsonl"))
            .unwrap()
            .len();
        assert!(rotated <= line * 3);
        // Newest first across both files; the oldest rotation is gone.
        let ats: Vec<u64> = log.recent(MAX_LIST).iter().map(|e| e.at).collect();
        assert_eq!(ats, vec![7, 6, 5, 4, 3]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unreadable_lines_are_skipped() {
        let dir = crate::test_support::tempdir("remote-audit", "garbage");
        let log = AuditLog::new(&dir);
        log.record(&entry(1));
        let mut file = OpenOptions::new()
            .append(true)
            .open(dir.join(FILE))
            .unwrap();
        file.write_all(b"not json\n").unwrap();
        log.record(&entry(2));
        assert_eq!(log.recent(10), vec![entry(2), entry(1)]);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
