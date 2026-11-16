//! `upload-*` frames: a phone sends an image for a prompt in chunks
//! (`remote/transfers.rs`). Uploading is a `control` request, since its only
//! use is a prompt. Each frame is answered with
//! `{t:"upload", uploadId, op, ok, error}`.

use std::time::Instant;

use serde_json::{json, Value};

use super::Authed;
use crate::remote::hub::Hub;
use crate::remote::scope::{self, action_scope};
use crate::remote::transfers::UploadError;

fn reply(hub: &Hub, session: &Authed, id: &str, op: &str, result: Result<(), &str>) {
    let text = json!({
        "t": "upload", "uploadId": id, "op": op,
        "ok": result.is_ok(), "error": result.err(),
    })
    .to_string();
    hub.send_text(session.conn, text);
}

pub(super) fn handle(hub: &Hub, session: &Authed, kind: &str, message: &Value) {
    let id = message
        .get("uploadId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let op = kind.trim_start_matches("upload-");
    if id.is_empty() || id.len() > 64 {
        return;
    }
    if let Err(error) = scope::check(hub.device_scope(&session.device.id), action_scope("prompt")) {
        reply(hub, session, id, op, Err(error));
        return;
    }
    let transfers = hub.transfers();
    let device = session.device.id.as_str();
    let result = match op {
        "begin" => {
            let mime = message
                .get("mime")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let size = message
                .get("size")
                .and_then(Value::as_u64)
                .and_then(|size| usize::try_from(size).ok())
                .unwrap_or(0);
            transfers.begin(device, id, mime, size, Instant::now())
        }
        "chunk" => {
            let seq = message.get("seq").and_then(Value::as_u64);
            let data = message.get("data").and_then(Value::as_str);
            match (seq, data) {
                (Some(seq), Some(data)) => transfers.chunk(device, id, seq, data),
                _ => Err(UploadError::BadRequest),
            }
        }
        "end" => transfers.end(device, id),
        _ => {
            transfers.cancel(device, id);
            Ok(())
        }
    };
    reply(
        hub,
        session,
        id,
        op,
        result.map_err(|error| error.message()),
    );
}
