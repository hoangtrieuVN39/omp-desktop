//! Tauri commands of the remote access feature. Each one runs its blocking
//! work (files, sockets, locks) off the IPC thread.

use std::sync::Arc;

use gix::bstr::ByteSlice as _;

use tauri::{AppHandle, Manager};

use super::audit::Entry;
use super::emit::Status;
use super::hub::PublishPayload;
use super::manager::{PairStart, RemoteManager};
use super::net::{self, Iface};
use super::settings::RemoteSettings;
use super::transfers::Image;

/// Run `work` against the managed [`RemoteManager`] on a blocking thread.
async fn with_manager<T: Send + 'static>(
    app: AppHandle,
    work: impl FnOnce(&RemoteManager) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let manager = app
        .try_state::<Arc<RemoteManager>>()
        .map(|state| Arc::clone(&state))
        .ok_or("remote access needs the app config directory")?;
    tauri::async_runtime::spawn_blocking(move || work(&manager))
        .await
        .map_err(|error| format!("join error: {error}"))?
}

#[tauri::command]
pub async fn remote_status(app: AppHandle) -> Result<Status, String> {
    with_manager(app, |manager| Ok(manager.status())).await
}

#[tauri::command]
pub async fn remote_interfaces() -> Result<Vec<Iface>, String> {
    tauri::async_runtime::spawn_blocking(net::interfaces)
        .await
        .map_err(|error| format!("join error: {error}"))?
}

#[tauri::command]
pub async fn remote_apply_settings(
    settings: RemoteSettings,
    app: AppHandle,
) -> Result<Status, String> {
    with_manager(app, move |manager| manager.apply(settings)).await
}

#[tauri::command]
pub async fn remote_pair_start(app: AppHandle) -> Result<PairStart, String> {
    with_manager(app, RemoteManager::pair_start).await
}

#[tauri::command]
pub async fn remote_pair_cancel(app: AppHandle) -> Result<(), String> {
    with_manager(app, |manager| {
        manager.pair_cancel();
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn remote_device_rename(
    id: String,
    name: String,
    app: AppHandle,
) -> Result<Status, String> {
    with_manager(app, move |manager| manager.device_rename(&id, &name)).await
}

#[tauri::command]
pub async fn remote_device_revoke(id: String, app: AppHandle) -> Result<Status, String> {
    with_manager(app, move |manager| manager.device_revoke(&id)).await
}

#[tauri::command]
pub async fn remote_regenerate_cert(app: AppHandle) -> Result<Status, String> {
    with_manager(app, RemoteManager::regenerate_cert).await
}

#[tauri::command]
pub async fn remote_publish(payload: PublishPayload, app: AppHandle) -> Result<(), String> {
    with_manager(app, move |manager| {
        manager.hub().publish(payload);
        Ok(())
    })
    .await
}

/// The webview's answer to a phone request; `data` is a query's result (or
/// an action's, such as a download id).
#[tauri::command]
pub async fn remote_action_result(
    req_id: String,
    ok: bool,
    error: Option<String>,
    data: Option<serde_json::Value>,
    app: AppHandle,
) -> Result<(), String> {
    with_manager(app, move |manager| {
        manager
            .hub()
            .action_result(&req_id, ok, error.as_deref(), data);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn remote_device_set_scope(
    id: String,
    scope: String,
    app: AppHandle,
) -> Result<Status, String> {
    with_manager(app, move |manager| manager.device_set_scope(&id, &scope)).await
}

#[tauri::command]
pub async fn remote_audit_list(limit: usize, app: AppHandle) -> Result<Vec<Entry>, String> {
    with_manager(app, move |manager| Ok(manager.audit_list(limit))).await
}

/// A finished image upload of `device_id` for its prompt; `None` when it is
/// unknown, unfinished, expired or already taken.
#[tauri::command]
pub async fn remote_take_upload(
    device_id: String,
    upload_id: String,
    app: AppHandle,
) -> Result<Option<Image>, String> {
    with_manager(app, move |manager| {
        Ok(manager.take_upload(&device_id, &upload_id))
    })
    .await
}

/// Offer the HTML export omp just wrote to one paired device. Only `.html`
/// files are offered: the path comes from omp's `export_html` answer.
#[tauri::command]
pub async fn remote_offer_download(
    device_id: String,
    path: String,
    app: AppHandle,
) -> Result<String, String> {
    with_manager(app, move |manager| {
        let path = std::path::PathBuf::from(path);
        let html = path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("html"));
        if !html || !path.is_absolute() {
            return Err("only an absolute .html export can be offered".to_owned());
        }
        manager.offer_download(&device_id, path)
    })
    .await
}

#[tauri::command]
pub async fn remote_ready(ready: bool, app: AppHandle) -> Result<(), String> {
    with_manager(app, move |manager| {
        manager.hub().set_ready(ready);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn remote_push_test(app: AppHandle) -> Result<(), String> {
    with_manager(app, RemoteManager::push_test).await
}

/// The `user.email` of the user's global and system git configuration, to
/// prefill the push contact; empty when it is not set. Read through gix: no
/// `git` process, and never the config of whatever repository the app was
/// started in.
#[tauri::command]
pub async fn remote_default_contact() -> String {
    tauri::async_runtime::spawn_blocking(git_user_email)
        .await
        .unwrap_or_default()
}

fn git_user_email() -> String {
    let _gate = crate::spawn_gate::shared();
    gix::config::File::from_globals().map_or_else(|_| String::new(), |config| user_email(&config))
}

fn user_email(config: &gix::config::File) -> String {
    config
        .string("user.email")
        .map_or_else(String::new, |email| email.to_str_lossy().trim().to_owned())
}

#[cfg(test)]
#[path = "commands_tests.rs"]
mod tests;
