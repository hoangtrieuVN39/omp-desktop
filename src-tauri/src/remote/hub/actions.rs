//! Phone requests in flight: forwarded to the webview under a hub-unique
//! correlation id, answered by that id, expired after [`ACTION_TIMEOUT`].
//! The phone's own `reqId` only comes back in its answer: two phones may pick
//! the same one. Actions are answered with `ack`, queries with `result`;
//! both may carry `data`, capped at [`MAX_RESULT`] bytes of JSON.

use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use super::{Hub, Out, ACTION_TIMEOUT, MAX_PENDING_PER_CONN, MAX_RESULT};
use crate::remote::audit::Entry;
use crate::remote::emit::Action;

pub(super) struct Pending {
    pub conn: u64,
    /// The `reqId` the phone chose, echoed in its answer.
    req_id: String,
    deadline: Instant,
    query: bool,
    device_id: String,
    kind: String,
    tab_id: String,
}

impl Pending {
    /// What the audit log records for an action's outcome; reads and tab
    /// selection are not recorded.
    fn audit(&self, ok: bool, error: Option<&str>) -> Option<Entry> {
        (!self.query && self.kind != "select").then(|| Entry {
            at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_secs()),
            device_id: self.device_id.clone(), // the entry outlives the pending slot
            device_name: String::new(),
            kind: self.kind.clone(),     // as above
            tab_id: self.tab_id.clone(), // as above
            ok,
            error: error.map(str::to_owned),
        })
    }
}

/// `{t:"ack"}` for an action, `{t:"result"}` for a query.
pub(super) fn answer(
    req_id: &str,
    query: bool,
    ok: bool,
    error: Option<&str>,
    data: Option<&Value>,
) -> Out {
    let t = if query { "result" } else { "ack" };
    let mut message = json!({ "t": t, "reqId": req_id, "ok": ok, "error": error });
    if let Some(data) = data {
        message["data"] = data.clone(); // the message owns its copy
    }
    Out::Text(message.to_string())
}

/// Refuse an answer bigger than [`MAX_RESULT`] instead of sending it.
fn bounded(
    ok: bool,
    error: Option<&str>,
    data: Option<Value>,
) -> (bool, Option<String>, Option<Value>) {
    match data {
        Some(value) if value.to_string().len() > MAX_RESULT => {
            (false, Some("result too large".to_owned()), None)
        }
        data => (ok, error.map(str::to_owned), data),
    }
}

impl Hub {
    /// Forward a phone request to the webview and start its 15 s clock.
    /// Requests of a connection the hub no longer knows (revoked, closed)
    /// are dropped. `action.req_id` is the phone's and non-empty (the socket
    /// layer checks); the webview gets the action under a fresh hub id.
    pub fn action(&self, conn: u64, action: &Action) {
        let forwarded = self.with_state(|state| {
            if !state.conns.contains_key(&conn) {
                return None;
            }
            let duplicate = state
                .pending
                .values()
                .any(|p| p.conn == conn && p.req_id == action.req_id);
            let mine = state.pending.values().filter(|p| p.conn == conn).count();
            let refusal = if duplicate {
                Some("duplicate reqId")
            } else if mine >= MAX_PENDING_PER_CONN {
                Some("too many pending requests")
            } else {
                None
            };
            if let Some(error) = refusal {
                state.send(
                    conn,
                    answer(&action.req_id, action.query, false, Some(error), None),
                );
                return None;
            }
            state.next_action += 1;
            let id = format!("act-{}", state.next_action);
            let mut forwarded = action.clone(); // the webview gets its own hub correlation id
            forwarded.req_id.clone_from(&id);
            forwarded.dispatched_at = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .ok()
                .and_then(|d| u64::try_from(d.as_millis()).ok());
            state.pending.insert(
                id,
                Pending {
                    conn,
                    req_id: action.req_id.clone(), // kept for the phone answer / timeout
                    deadline: Instant::now() + ACTION_TIMEOUT,
                    query: action.query,
                    device_id: action.device_id.clone(), // kept for the audit entry
                    kind: action.kind.clone(),           // as above
                    tab_id: action.tab_id.clone(),       // as above
                },
            );
            Some(forwarded)
        });
        if let Some(forwarded) = forwarded {
            self.emit.action(&forwarded);
        }
    }

    /// The webview's answer by hub id; unknown or already expired ids are
    /// ignored.
    pub fn action_result(&self, id: &str, ok: bool, error: Option<&str>, data: Option<Value>) {
        let (ok, error, data) = bounded(ok, error, data);
        let audit = self.with_state(|state| {
            let pending = state.pending.remove(id)?;
            state.send(
                pending.conn,
                answer(
                    &pending.req_id,
                    pending.query,
                    ok,
                    error.as_deref(),
                    data.as_ref(),
                ),
            );
            pending.audit(ok, error.as_deref())
        });
        if let Some(entry) = audit {
            self.record(entry);
        }
    }

    /// Refuse a request that never reached the webview.
    pub fn reject(&self, conn: u64, req_id: &str, error: &str, query: bool) {
        self.with_state(|state| state.send(conn, answer(req_id, query, false, Some(error), None)));
    }

    /// Outcome of a push (un)subscribe, which has no request id:
    /// `{t:"ack", reqId:null, kind:"push", ok, error}`.
    pub fn push_ack(&self, conn: u64, result: &Result<(), String>) {
        let text = json!({
            "t": "ack", "reqId": null, "kind": "push",
            "ok": result.is_ok(), "error": result.as_ref().err(),
        })
        .to_string();
        self.with_state(|state| state.send(conn, Out::Text(text)));
    }

    /// Answer this connection's requests that the webview let time out.
    pub fn expire(&self, conn: u64, now: Instant) {
        let audits = self.with_state(|state| {
            let late: Vec<String> = state
                .pending
                .iter()
                .filter(|(_, pending)| pending.conn == conn && pending.deadline <= now)
                .map(|(id, _)| id.clone()) // removed from the map below
                .collect();
            let mut audits = Vec::new();
            for id in late {
                if let Some(pending) = state.pending.remove(&id) {
                    let error = "desktop did not answer";
                    state.send(
                        conn,
                        answer(&pending.req_id, pending.query, false, Some(error), None),
                    );
                    audits.extend(pending.audit(false, Some(error)));
                }
            }
            audits
        });
        for entry in audits {
            self.record(entry);
        }
    }

    /// Write an audit entry (lock released), naming the device.
    fn record(&self, mut entry: Entry) {
        let Some(log) = self.audit.get() else {
            return;
        };
        entry.device_name = self
            .devices
            .list()
            .into_iter()
            .find(|device| device.id == entry.device_id)
            .map_or_default(|device| device.name);
        log.record(&entry);
    }
}
