//! Types shared between the hub, the manager and the webview bridge.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::scope::Scope;
use super::settings::RemoteSettings;

/// A phone request handed to the desktop webview: an action (it changes
/// something) or, with `query` set, a read whose answer carries data.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    pub req_id: String,
    pub device_id: String,
    /// The tab the request is for; empty for a query that needs no tab.
    pub tab_id: String,
    /// An action kind or a query name of `scope::ACTIONS` / `scope::QUERIES`.
    pub kind: String,
    #[serde(default)]
    pub query: bool,
    pub text: Option<String>,
    pub ask_id: Option<String>,
    pub value: Option<Value>,
    /// Kind-specific arguments; the webview validates them per kind.
    #[serde(default)]
    pub args: Option<Value>,
    #[serde(default)]
    pub dispatched_at: Option<u64>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStatus {
    pub id: String,
    pub name: String,
    pub paired_at: u64,
    pub last_seen: u64,
    pub connected: bool,
    pub push_subscribed: bool,
    pub scope: Scope,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enabled: bool,
    pub listening: bool,
    pub url: Option<String>,
    pub ip: Option<String>,
    pub error: Option<String>,
    pub fingerprint: Option<String>,
    pub devices: Vec<DeviceStatus>,
    /// Why the last push failed (or could not be set up), if it did.
    pub push_error: Option<String>,
    /// Whether this platform can tell that the desktop is locked, so the
    /// Settings page offers "only while locked".
    pub lock_detection: bool,
    /// The saved settings, so the Settings page prefills from them.
    pub settings: RemoteSettings,
}

/// Outbound edge towards the desktop webview.
pub trait RemoteEmit: Send + Sync {
    /// Tab ids the phones need updates for; empty while no phone is connected.
    fn watch(&self, tab_ids: &[String]);
    /// Ids of the devices with an open socket, sorted. Called whenever that
    /// set changes (a first socket opens, the last one of a device closes,
    /// a socket is revoked or dropped), so the manager can refresh `Status`
    /// and the webview learns that phones appeared before they ask anything.
    fn connections(&self, device_ids: &[String]);
    fn action(&self, action: &Action);
    fn status(&self, status: &Status);
}
