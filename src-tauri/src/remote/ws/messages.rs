//! Incoming WebSocket message parsing, scope checks, request validation, and
//! hub dispatch. Every request is checked against the device's *current*
//! scope (`remote/scope.rs`) before it reaches the webview.

use serde_json::Value;

use super::Authed;
use crate::remote::emit::Action;
use crate::remote::hub::Hub;
use crate::remote::push_subs::parse_subscription;
use crate::remote::scope::{self, action_scope, query_scope, Scope};

/// Limit for an action's `text`, and for its `value` and `args` as JSON.
const MAX_TEXT: usize = 32 * 1024;
const MAX_ID_LEN: usize = 128;
const MAX_ASK_ID_LEN: usize = 256;

fn text_field(message: &Value, key: &str) -> Option<String> {
    message.get(key).and_then(Value::as_str).map(str::to_owned)
}

pub(super) fn handle(hub: &Hub, session: &Authed, text: &str) {
    let Ok(message) = serde_json::from_str::<Value>(text) else {
        return;
    };
    match message.get("t").and_then(Value::as_str) {
        Some("select") => {
            let allowed =
                scope::check(hub.device_scope(&session.device.id), action_scope("select"));
            if let (Ok(()), Some(action)) = (allowed, build(session, &message, "select", false)) {
                hub.action(session.conn, &action);
            }
        }
        Some(kind @ ("action" | "query")) => {
            let query = kind == "query";
            let req_id = text_field(&message, "reqId").unwrap_or_default();
            let name = text_field(&message, if query { "q" } else { "kind" }).unwrap_or_default();
            let needed = if query {
                query_scope(&name)
            } else {
                // `select` has its own frame; it is not an action kind here.
                action_scope(&name).filter(|_| name != "select")
            };
            // Answering with a remembered approval saves a standing rule: that is Manage.
            let needed = if name == "answer" && message.pointer("/args/grant").is_some() {
                Some(Scope::Manage)
            } else {
                needed
            };
            if let Err(error) = scope::check(hub.device_scope(&session.device.id), needed) {
                reject(hub, session, &req_id, error, query);
                return;
            }
            match build(session, &message, &name, query) {
                Some(action) => hub.action(session.conn, &action),
                None => reject(hub, session, &req_id, "bad request", query),
            }
        }
        Some("push-subscribe") => {
            let result = parse_subscription(message.get("sub"))
                .and_then(|sub| hub.subscribe(&session.device.id, sub));
            hub.push_ack(session.conn, &result);
        }
        Some("push-unsubscribe") => {
            hub.push_ack(session.conn, &hub.unsubscribe(&session.device.id));
        }
        Some(kind @ ("upload-begin" | "upload-chunk" | "upload-end" | "upload-cancel")) => {
            super::uploads::handle(hub, session, kind, &message);
        }
        _ => {}
    }
}

/// Answer a refused request through the hub's own ack path.
fn reject(hub: &Hub, session: &Authed, req_id: &str, error: &str, query: bool) {
    if req_id.is_empty() || req_id.len() > MAX_ID_LEN {
        return;
    }
    hub.reject(session.conn, req_id, error, query);
}

fn bounded_json(message: &Value, key: &str) -> Result<Option<Value>, ()> {
    let value = message.get(key).filter(|value| !value.is_null()).cloned(); // owned for the webview event
    if value
        .as_ref()
        .is_some_and(|value| value.to_string().len() > MAX_TEXT)
    {
        return Err(());
    }
    Ok(value)
}

fn build(session: &Authed, message: &Value, kind: &str, query: bool) -> Option<Action> {
    let req_id =
        text_field(message, "reqId").filter(|id| !id.is_empty() && id.len() <= MAX_ID_LEN)?;
    // A query may name no tab (projects, profiles); everything else needs one.
    let tab_id = match text_field(message, "tabId") {
        Some(id) if !id.is_empty() && id.len() <= MAX_ID_LEN => id,
        None if query => String::new(),
        _ => return None,
    };
    let text = text_field(message, "text").filter(|text| text.len() <= MAX_TEXT);
    if message.get("text").is_some_and(|raw| !raw.is_null()) && text.is_none() {
        return None;
    }
    let ask_id = text_field(message, "askId").filter(|id| id.len() <= MAX_ASK_ID_LEN);
    if message.get("askId").is_some_and(|raw| !raw.is_null()) && ask_id.is_none() {
        return None;
    }
    let value = bounded_json(message, "value").ok()?;
    let args = bounded_json(message, "args").ok()?;
    if args.as_ref().is_some_and(|args| !args.is_object()) {
        return None;
    }
    Some(Action {
        req_id,
        device_id: session.device.id.clone(), // the action outlives the session borrow
        tab_id,
        kind: kind.to_owned(),
        query,
        text,
        ask_id,
        value,
        args,
        dispatched_at: None,
    })
}
