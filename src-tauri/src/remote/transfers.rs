//! Files moving between a phone and the desktop outside the 1 MiB socket
//! frame limit.
//!
//! - **Uploads** (phone → desktop): images for a prompt, sent as base64
//!   chunks over the socket (`upload-begin` / `upload-chunk` / `upload-end`).
//!   A finished upload waits, bound to its device, until the webview takes
//!   it for that device's `prompt`.
//! - **Downloads** (desktop → phone): a file the webview offers to one
//!   device (an HTML export). The phone fetches it once with
//!   `GET /download/<id>` and its bearer token.
//!
//! Everything is bounded (count, size, age) and lives in memory only.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use base64::Engine as _;

use super::rand::random_b64;

/// Image types the prompt accepts unchanged (`app/image-attach.js`).
pub const UPLOAD_MIME: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];
/// Per image, as `app/image-attach.js` `MAX_PASSTHROUGH_BYTES`: the phone
/// downsizes before it sends.
pub const MAX_UPLOAD_BYTES: usize = 1536 * 1024;
/// Decoded bytes per chunk; its base64 stays well inside a socket frame.
pub const MAX_CHUNK_BYTES: usize = 256 * 1024;
/// `app/image-attach.js` `MAX_ATTACHMENTS`: one message's worth per device.
pub const MAX_UPLOADS_PER_DEVICE: usize = 8;
pub const UPLOAD_TTL: Duration = Duration::from_mins(10);
pub const MAX_DOWNLOAD_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_DOWNLOADS_PER_DEVICE: usize = 4;
pub const DOWNLOAD_TTL: Duration = Duration::from_mins(5);
const MAX_ID_LEN: usize = 64;

#[derive(Debug, PartialEq, Eq)]
pub enum UploadError {
    BadRequest,
    UnsupportedType,
    TooLarge,
    TooMany,
    Unknown,
    OutOfOrder,
    Incomplete,
}

impl UploadError {
    pub const fn message(&self) -> &'static str {
        match self {
            Self::BadRequest => "bad request",
            Self::UnsupportedType => "unsupported image type",
            Self::TooLarge => "image too large",
            Self::TooMany => "too many uploads",
            Self::Unknown => "unknown upload",
            Self::OutOfOrder => "chunk out of order",
            Self::Incomplete => "upload incomplete",
        }
    }
}

struct Upload {
    device_id: String,
    mime: String,
    size: usize,
    next_seq: u64,
    bytes: Vec<u8>,
    done: bool,
    started: Instant,
}

/// A finished upload as the prompt wants it.
#[derive(serde::Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Image {
    pub mime_type: String,
    /// Base64, as omp's `prompt` takes images.
    pub data: String,
}

struct Download {
    device_id: String,
    path: PathBuf,
    offered: Instant,
}

#[derive(Default)]
struct Inner {
    uploads: HashMap<String, Upload>,
    downloads: HashMap<String, Download>,
}

#[derive(Default)]
pub struct Transfers {
    inner: Mutex<Inner>,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_LEN
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

impl Transfers {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn prune(inner: &mut Inner, now: Instant) {
        inner
            .uploads
            .retain(|_, up| now.saturating_duration_since(up.started) < UPLOAD_TTL);
        inner
            .downloads
            .retain(|_, down| now.saturating_duration_since(down.offered) < DOWNLOAD_TTL);
    }

    /// Run `change` on the store under its lock; the guard never outlives it.
    fn with<R>(&self, change: impl FnOnce(&mut Inner) -> R) -> R {
        change(&mut self.lock())
    }

    /// Start an upload the phone named `id`; ids are per device.
    pub fn begin(
        &self,
        device_id: &str,
        id: &str,
        mime: &str,
        size: usize,
        now: Instant,
    ) -> Result<(), UploadError> {
        if !valid_id(id) {
            return Err(UploadError::BadRequest);
        }
        if !UPLOAD_MIME.contains(&mime) {
            return Err(UploadError::UnsupportedType);
        }
        if size == 0 || size > MAX_UPLOAD_BYTES {
            return Err(UploadError::TooLarge);
        }
        let key = format!("{device_id}/{id}");
        self.with(|inner| {
            Self::prune(inner, now);
            let held = inner
                .uploads
                .values()
                .filter(|up| up.device_id == device_id)
                .count();
            if !inner.uploads.contains_key(&key) && held >= MAX_UPLOADS_PER_DEVICE {
                return Err(UploadError::TooMany);
            }
            inner.uploads.insert(
                key,
                Upload {
                    device_id: device_id.to_owned(),
                    mime: mime.to_owned(),
                    size,
                    next_seq: 0,
                    bytes: Vec::with_capacity(size),
                    done: false,
                    started: now,
                },
            );
            Ok(())
        })
    }

    /// Append chunk `seq` (0, 1, 2, … in order) of base64 `data`.
    pub fn chunk(
        &self,
        device_id: &str,
        id: &str,
        seq: u64,
        data: &str,
    ) -> Result<(), UploadError> {
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|_| UploadError::BadRequest)?;
        if decoded.is_empty() || decoded.len() > MAX_CHUNK_BYTES {
            return Err(UploadError::BadRequest);
        }
        let key = format!("{device_id}/{id}");
        self.with(|inner| {
            let up = inner.uploads.get_mut(&key).ok_or(UploadError::Unknown)?;
            if up.done || seq != up.next_seq {
                return Err(UploadError::OutOfOrder);
            }
            if up.bytes.len() + decoded.len() > up.size {
                inner.uploads.remove(&key);
                return Err(UploadError::TooLarge);
            }
            up.bytes.extend_from_slice(&decoded);
            up.next_seq += 1;
            Ok(())
        })
    }

    /// Close an upload: every announced byte must have arrived.
    pub fn end(&self, device_id: &str, id: &str) -> Result<(), UploadError> {
        let key = format!("{device_id}/{id}");
        self.with(|inner| {
            let up = inner.uploads.get_mut(&key).ok_or(UploadError::Unknown)?;
            if up.bytes.len() != up.size {
                inner.uploads.remove(&key);
                return Err(UploadError::Incomplete);
            }
            up.done = true;
            Ok(())
        })
    }

    pub fn cancel(&self, device_id: &str, id: &str) {
        let key = format!("{device_id}/{id}");
        self.with(|inner| inner.uploads.remove(&key));
    }

    /// Hand a finished upload of `device_id` to the webview, once.
    pub fn take_upload(&self, device_id: &str, id: &str, now: Instant) -> Option<Image> {
        let key = format!("{device_id}/{id}");
        let up = self.with(|inner| {
            Self::prune(inner, now);
            if !inner.uploads.get(&key)?.done {
                return None;
            }
            inner.uploads.remove(&key)
        })?;
        Some(Image {
            mime_type: up.mime,
            data: base64::engine::general_purpose::STANDARD.encode(up.bytes),
        })
    }

    /// Offer the file at `path` to one device; returns the download id.
    pub fn offer(&self, device_id: &str, path: PathBuf, now: Instant) -> Result<String, String> {
        let meta = std::fs::metadata(&path).map_err(|error| error.to_string())?;
        if !meta.is_file() {
            return Err("not a file".to_owned());
        }
        if meta.len() > MAX_DOWNLOAD_BYTES {
            return Err("file too large".to_owned());
        }
        let id = random_b64(18)?;
        self.with(|inner| {
            Self::prune(inner, now);
            let oldest = inner
                .downloads
                .iter()
                .filter(|(_, down)| down.device_id == device_id)
                .min_by_key(|(_, down)| down.offered)
                .map(|(id, _)| id.clone()); // evicted below if the device is at its cap
            let held = inner
                .downloads
                .values()
                .filter(|down| down.device_id == device_id)
                .count();
            if let Some(oldest) = oldest.filter(|_| held >= MAX_DOWNLOADS_PER_DEVICE) {
                inner.downloads.remove(&oldest);
            }
            inner.downloads.insert(
                id.clone(), // the caller gets the id as well
                Download {
                    device_id: device_id.to_owned(),
                    path,
                    offered: now,
                },
            );
        });
        Ok(id)
    }

    /// Serve download `id` to `device_id`, once. A wrong device leaves the
    /// offer in place: only its own device may use it up.
    pub fn serve(&self, device_id: &str, id: &str, now: Instant) -> Option<Vec<u8>> {
        let download = self.with(|inner| {
            Self::prune(inner, now);
            if inner.downloads.get(id)?.device_id != device_id {
                return None;
            }
            inner.downloads.remove(id)
        })?;
        let bytes = std::fs::read(&download.path).ok()?;
        (bytes.len() as u64 <= MAX_DOWNLOAD_BYTES).then_some(bytes)
    }
}

#[cfg(test)]
#[path = "transfers_tests.rs"]
mod tests;
