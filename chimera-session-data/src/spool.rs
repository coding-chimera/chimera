use napi_derive::napi;
use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Direction {
    Head,
    Tail,
}

#[napi(object)]
#[derive(Debug)]
pub struct SpoolFinish {
    pub content: String,
    pub truncated: bool,
    pub output_path: Option<String>,
    pub removed: i64,
    pub unit: String,
    pub total_bytes: i64,
    pub total_lines: i64,
}

pub struct OutputSpool {
    path: PathBuf,
    file: Option<File>,
    max_lines: usize,
    max_bytes: usize,
    direction: Direction,
    pending: Vec<u8>,
    selected: VecDeque<Vec<u8>>,
    selected_bytes: usize,
    total_bytes: u64,
    total_lines: u64,
    hit_bytes: bool,
    head_complete: bool,
    keep_file: bool,
}

impl OutputSpool {
    pub fn new(
        file_path: String,
        max_lines: u32,
        max_bytes: u32,
        direction: Direction,
    ) -> Result<Self, String> {
        let path = PathBuf::from(file_path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&path)
            .map_err(|error| format!("failed to open spool {}: {error}", path.display()))?;
        Ok(Self {
            path,
            file: Some(file),
            max_lines: max_lines as usize,
            max_bytes: max_bytes as usize,
            direction,
            pending: Vec::new(),
            selected: VecDeque::new(),
            selected_bytes: 0,
            total_bytes: 0,
            total_lines: 0,
            hit_bytes: false,
            head_complete: false,
            keep_file: false,
        })
    }

    pub fn append(&mut self, chunk: &[u8]) -> Result<(), String> {
        if self.file.is_none() {
            return Err("spool is already closed".to_string());
        }
        self.total_bytes = self
            .total_bytes
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| "spool byte count overflow".to_string())?;
        self.file
            .as_mut()
            .expect("checked above")
            .write_all(chunk)
            .map_err(|error| format!("failed to write spool {}: {error}", self.path.display()))?;
        let mut start = 0;
        for (index, byte) in chunk.iter().enumerate() {
            if *byte == b'\n' {
                self.pending.extend_from_slice(&chunk[start..index]);
                let line = std::mem::take(&mut self.pending);
                self.push_line(line);
                start = index + 1;
            }
        }
        self.pending.extend_from_slice(&chunk[start..]);
        Ok(())
    }

    fn push_line(&mut self, line: Vec<u8>) {
        self.total_lines += 1;
        match self.direction {
            Direction::Head => self.push_head(line),
            Direction::Tail => self.push_tail(line),
        }
    }

    fn push_head(&mut self, line: Vec<u8>) {
        if self.head_complete {
            return;
        }
        if self.selected.len() >= self.max_lines {
            self.head_complete = true;
            return;
        }
        let size = line.len() + usize::from(!self.selected.is_empty());
        if self.selected_bytes + size > self.max_bytes {
            self.hit_bytes = true;
            self.head_complete = true;
            return;
        }
        self.selected_bytes += size;
        self.selected.push_back(line);
    }

    fn push_tail(&mut self, line: Vec<u8>) {
        self.selected.push_front(line);
        let mut bytes = 0;
        let mut count = 0;
        let mut hit_bytes = false;
        for line in self.selected.iter() {
            if count >= self.max_lines {
                break;
            }
            let size = line.len() + usize::from(count > 0);
            if bytes + size > self.max_bytes {
                hit_bytes = true;
                break;
            }
            bytes += size;
            count += 1;
        }
        self.selected.truncate(count);
        self.selected_bytes = bytes;
        if hit_bytes {
            self.hit_bytes = true;
        }
    }

    pub fn finish(&mut self) -> Result<SpoolFinish, String> {
        if self.file.is_none() {
            return Err("spool is already closed".to_string());
        }
        let pending = std::mem::take(&mut self.pending);
        self.push_line(pending);
        self.file
            .take()
            .expect("checked above")
            .flush()
            .map_err(|error| format!("failed to flush spool {}: {error}", self.path.display()))?;
        let truncated =
            self.total_lines > self.max_lines as u64 || self.total_bytes > self.max_bytes as u64;
        if !truncated {
            self.keep_file = true;
            std::fs::remove_file(&self.path)
                .map_err(|error| format!("failed to remove unused spool: {error}"))?;
        } else {
            self.keep_file = true;
        }
        let preview = if self.direction == Direction::Tail {
            self.selected
                .iter()
                .rev()
                .map(|line| String::from_utf8_lossy(line).into_owned())
                .collect::<Vec<_>>()
                .join("\n")
        } else {
            self.selected
                .iter()
                .map(|line| String::from_utf8_lossy(line).into_owned())
                .collect::<Vec<_>>()
                .join("\n")
        };
        let removed = if self.hit_bytes {
            self.total_bytes - self.selected_bytes as u64
        } else {
            self.total_lines - self.selected.len() as u64
        };
        Ok(SpoolFinish {
            content: preview,
            truncated,
            output_path: truncated.then(|| self.path.to_string_lossy().into_owned()),
            removed: i64::try_from(removed).map_err(|_| "removed count exceeds i64".to_string())?,
            unit: if self.hit_bytes {
                "bytes".to_string()
            } else {
                "lines".to_string()
            },
            total_bytes: i64::try_from(self.total_bytes)
                .map_err(|_| "total bytes exceed i64".to_string())?,
            total_lines: i64::try_from(self.total_lines)
                .map_err(|_| "total lines exceed i64".to_string())?,
        })
    }

    pub fn abort(&mut self) -> Result<(), String> {
        self.file.take();
        self.keep_file = true;
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!(
                "failed to abort spool {}: {error}",
                self.path.display()
            )),
        }
    }
}

impl Drop for OutputSpool {
    fn drop(&mut self) {
        if !self.keep_file {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn path(name: &str) -> String {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir()
            .join(format!("chimera-spool-{nonce}-{name}"))
            .to_string_lossy()
            .into_owned()
    }

    fn spool(name: &str, max_lines: u32, max_bytes: u32, direction: Direction) -> OutputSpool {
        OutputSpool::new(path(name), max_lines, max_bytes, direction).unwrap()
    }

    #[test]
    fn under_limit_returns_content_and_removes_file() {
        let mut spool = spool("under", 10, 100, Direction::Head);
        let path = spool.path.clone();
        spool.append(b"line1\nline2").unwrap();
        let result = spool.finish().unwrap();
        assert!(!result.truncated);
        assert_eq!(result.content, "line1\nline2");
        assert!(!path.exists());
    }

    #[test]
    fn head_truncates_across_chunk_boundaries() {
        let mut spool = spool("head", 3, 1000, Direction::Head);
        for chunk in [&b"line0\nli"[..], &b"ne1\nline2\nline3"[..]] {
            spool.append(chunk).unwrap();
        }
        let result = spool.finish().unwrap();
        assert!(result.truncated);
        assert_eq!(result.content, "line0\nline1\nline2");
        assert_eq!(result.removed, 1);
        assert_eq!(result.unit, "lines");
        assert_eq!(
            std::fs::read_to_string(spool.path.clone()).unwrap(),
            "line0\nline1\nline2\nline3"
        );
    }

    #[test]
    fn tail_preserves_reverse_budget_semantics() {
        let mut spool = spool("tail", 2, 1000, Direction::Tail);
        spool.append(b"line0\nline1\nline2\nline3").unwrap();
        let result = spool.finish().unwrap();
        assert_eq!(result.content, "line2\nline3");
        assert_eq!(result.removed, 2);
        assert_eq!(result.unit, "lines");
    }

    #[test]
    fn tail_byte_budget_matches_newest_first() {
        let mut exact = spool("tail-bytes-exact", 100, 12, Direction::Tail);
        exact.append(b"aaaa\nbbbb\ncc").unwrap();
        let exact_result = exact.finish().unwrap();
        assert!(!exact_result.truncated);
        assert_eq!(exact_result.content, "aaaa\nbbbb\ncc");

        let mut truncated = spool("tail-bytes-truncated", 100, 11, Direction::Tail);
        truncated.append(b"aaaa\nbbbb\ncc").unwrap();
        let result = truncated.finish().unwrap();
        assert!(result.truncated);
        assert_eq!(result.content, "bbbb\ncc");
        assert_eq!(result.removed, 5);
        assert_eq!(result.unit, "bytes");
    }

    #[test]
    fn empty_input_is_not_truncated() {
        let mut spool = spool("empty", 10, 100, Direction::Head);
        let result = spool.finish().unwrap();
        assert!(!result.truncated);
        assert_eq!(result.total_lines, 1);
        assert_eq!(result.content, "");
    }

    #[test]
    fn trailing_newline_preserves_empty_last_line() {
        let mut spool = spool("trailing", 1, 100, Direction::Tail);
        spool.append(b"a\n").unwrap();
        let result = spool.finish().unwrap();
        assert!(result.truncated);
        assert_eq!(result.content, "");
        assert_eq!(result.total_lines, 2);
    }

    #[test]
    fn abort_deletes_output() {
        let mut spool = spool("abort", 10, 100, Direction::Head);
        let path = spool.path.clone();
        spool.append(b"partial").unwrap();
        spool.abort().unwrap();
        assert!(!path.exists());
    }
}
