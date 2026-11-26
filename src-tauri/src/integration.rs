//! Narrow page adapter API. Never grant account/password management to WhatsApp.
use crate::i18n::tr;
use crate::{accounts, notify};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Webview};
#[derive(Default)]
pub struct Integration(pub Mutex<HashMap<String, Adapter>>);
#[derive(Clone, Default, Serialize)]
pub struct Adapter {
    pub mounted: bool,
    pub detector: bool,
    pub theme: Option<String>,
    #[serde(skip)]
    pub last_signal: Option<Instant>,
    #[serde(skip)]
    pub signals: u32,
}
pub fn local_url(u: &tauri::Url) -> bool {
    matches!(
        (u.scheme(), u.host_str()),
        ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost"))
    )
}
pub fn trusted_local(v: &Webview) -> bool {
    (matches!(v.label(), "settings" | "lock") || v.label().starts_with("shell-"))
        && v.url().is_ok_and(|u| local_url(&u))
}
fn local(v: &Webview, app: &AppHandle) -> Result<(), String> {
    if !trusted_local(v) || !v.url().is_ok_and(|u| local_url(&u)) {
        return Err("forbidden".into());
    }
    crate::lock::require_unlocked(app)
}
pub fn remote(v: &Webview) -> Result<(), String> {
    if !v.label().starts_with("wa-")
        || !v
            .url()
            .is_ok_and(|u| u.scheme() == "https" && u.host_str() == Some("web.whatsapp.com"))
    {
        return Err("forbidden".into());
    }
    Ok(())
}
#[derive(Clone, Serialize)]
pub struct DisplayAccount {
    pub id: String,
    pub name: String,
    pub photo: Option<String>,
    pub unread: u32,
    pub detached: bool,
    pub is_default: bool,
}
pub fn display_accounts(app: &AppHandle) -> Vec<DisplayAccount> {
    let f = accounts::load(app);
    let counts = app.state::<accounts::UnreadMap>().lock().unwrap().clone();
    let startup = accounts::startup_account(&f).map(|a| a.id.clone());
    let mut list = f.accounts.clone();
    list.sort_by_key(|a| a.order);
    list.into_iter()
        .map(|a| DisplayAccount {
            id: a.id.clone(),
            name: a.name,
            photo: crate::accountphoto::data_url(app, &a.id),
            unread: counts.get(&a.id).copied().unwrap_or(0),
            detached: cfg!(windows)
                && app
                    .get_webview(&accounts::window_label(&a.id))
                    .is_some_and(|v| v.window().label().starts_with("detached-")),
            is_default: startup.as_deref() == Some(&a.id),
        })
        .collect()
}
#[derive(Serialize)]
pub struct BridgeState {
    pub accounts: Vec<DisplayAccount>,
    pub current_id: String,
    pub native_notifications: bool,
    pub notification_epoch: u64,
    pub notifications_locked: bool,
    pub windows: bool,
}
fn bridge_state(app: &AppHandle, label: &str) -> BridgeState {
    BridgeState {
        accounts: if crate::lock::is_unlocked(app) {
            display_accounts(app)
        } else {
            vec![]
        },
        current_id: accounts::id_from_label(label).unwrap_or("").into(),
        native_notifications: app.state::<notify::Recent>().native_ready(label),
        notification_epoch: app.state::<notify::Recent>().epoch(),
        notifications_locked: !crate::lock::is_unlocked(app),
        windows: cfg!(windows),
    }
}
#[tauri::command]
pub fn integration_state(window: Webview, app: AppHandle) -> Result<BridgeState, String> {
    remote(&window)?;
    Ok(bridge_state(&app, window.label()))
}

/// Accept only this WhatsApp webview's own profile details. The account id is
/// derived from its trusted `wa-<id>` label, never supplied by page JavaScript.
#[tauri::command]
pub fn sync_whatsapp_profile(
    window: Webview,
    app: AppHandle,
    profile_name: String,
    photo_png: Option<Vec<u8>>,
) -> Result<(), String> {
    remote(&window)?;
    crate::lock::require_unlocked(&app)?;
    let id = accounts::id_from_label(window.label())
        .ok_or_else(|| "invalid account window".to_owned())?
        .to_owned();

    let name = profile_name.trim();
    if name.chars().count() > 128 || name.chars().any(char::is_control) {
        return Err("invalid profile name".into());
    }
    let photo_png = photo_png.filter(|bytes| !bytes.is_empty());
    if photo_png
        .as_ref()
        .is_some_and(|bytes| bytes.len() > 256 * 1024)
    {
        return Err("profile photo is too large".into());
    }

    let _guard = accounts::lock_mutations();
    let mut file = accounts::load(&app);
    let account = file
        .accounts
        .iter()
        .find(|account| account.id == id)
        .ok_or_else(|| "unknown account".to_owned())?;
    let old_name = account.name.clone();
    let name_changed = !name.is_empty() && accounts::sync_whatsapp_name(&mut file, &id, name)?;
    let photo_changed = if let Some(png) = photo_png {
        crate::accountphoto::set_whatsapp_profile(&app, &id, &png)?
    } else {
        false
    };
    let changed = name_changed || photo_changed;
    let new_name = file
        .accounts
        .iter()
        .find(|account| account.id == id)
        .map(|account| account.name.clone())
        .unwrap_or(old_name.clone());
    if name_changed {
        accounts::save(&app, &file).map_err(|e| e.to_string())?;
    }
    drop(_guard);

    if !changed {
        return Ok(());
    }
    if new_name != old_name {
        if let Some(view) = app.get_webview(&accounts::window_label(&id)) {
            #[cfg(windows)]
            let visible = crate::sessions::selected(&app, view.window().label()).as_deref()
                == Some(view.label());
            #[cfg(not(windows))]
            let visible = !crate::sessions::enabled()
                || crate::sessions::selected(&app, view.window().label()).as_deref()
                    == Some(view.label());
            if visible {
                let _ = view
                    .window()
                    .set_title(&format!("Venwhatsapp — {new_name}"));
            }
        }
        crate::tray::rebuild_menu(&app);
    }
    crate::appicon::apply_account(&app, &id);
    broadcast(&app);
    Ok(())
}
pub fn broadcast(app: &AppHandle) {
    for (label, v) in app.webviews() {
        if label.starts_with("wa-") {
            if let Ok(json) = serde_json::to_string(&bridge_state(app, &label)) {
                let _ = v.eval(format!(
                    "window.__whatrustState && window.__whatrustState({json})"
                ));
            }
        } else if label == "settings" {
            let _ = v.eval("typeof loadAccounts === 'function' && !accountsBusy && loadAccounts()");
        } else if label.starts_with("shell-") {
            let current = crate::sessions::selected(app, v.window().label())
                .and_then(|label| accounts::id_from_label(&label).map(str::to_owned));
            if let Ok(json) = serde_json::to_string(&current) {
                let _ = v.eval(format!("window.refresh && window.refresh({json})"));
            }
        }
    }
}
#[tauri::command(async)]
pub fn report_integration(
    window: Webview,
    app: AppHandle,
    mounted: bool,
    detector: bool,
    theme: Option<String>,
) -> Result<(), String> {
    remote(&window)?;
    app.state::<Integration>()
        .0
        .lock()
        .unwrap()
        .entry(window.label().into())
        .or_default()
        .clone_from(&Adapter {
            mounted,
            detector,
            theme: theme.filter(|t| matches!(t.as_str(), "dark" | "light")),
            last_signal: None,
            signals: 0,
        });
    crate::sessions::integration_changed(&app, window.label(), mounted);
    crate::dlog::log(&format!(
        "integration: layout completed controls_mounted={mounted} detector={detector}"
    ));
    Ok(())
}
#[derive(Deserialize)]
pub struct MessageSignal {
    pub id: String,
    pub active: bool,
    pub muted: Option<bool>,
}
#[tauri::command]
pub fn report_message_signal(
    window: Webview,
    app: AppHandle,
    signal: MessageSignal,
) -> Result<(), String> {
    remote(&window)?;
    if !cfg!(windows) {
        return Ok(());
    }
    if signal.id.is_empty() || signal.id.len() > 180 {
        return Err("invalid signal".into());
    }
    let state = app.state::<Integration>();
    let mut m = state.0.lock().unwrap();
    let a = m.entry(window.label().into()).or_default();
    // Bound abusive/faulty adapters independently of the JavaScript limiter.
    if a.last_signal
        .is_none_or(|t| t.elapsed() > Duration::from_secs(60))
    {
        a.last_signal = Some(Instant::now());
        a.signals = 0;
    }
    if a.signals >= 600 {
        return Ok(());
    }
    a.signals += 1;
    drop(m);
    notify::visual_signal(
        &app,
        window.label(),
        &signal.id,
        signal.active,
        signal.muted,
    );
    Ok(())
}
#[tauri::command]
pub async fn open_app_panel(window: Webview, app: AppHandle) -> Result<(), String> {
    if window.label().starts_with("wa-") {
        remote(&window)?;
    } else {
        local(&window, &app)?;
    }
    if crate::sessions::enabled() {
        crate::sessions::open_panel(&app, Some(window.window().label()))
            .map_err(|e| e.to_string())?;
    } else {
        crate::window::open_settings_window(&app);
    }
    Ok(())
}

/// Open the trusted settings panel directly on History from the logger's gear.
#[tauri::command]
pub async fn open_history_settings(window: Webview, app: AppHandle) -> Result<(), String> {
    remote(&window)?;
    if crate::sessions::enabled() {
        crate::sessions::open_panel(&app, Some(window.window().label()))
            .map_err(|e| e.to_string())?;
    } else {
        crate::window::open_settings_window(&app);
    }
    if let Some(settings) = app.get_webview("settings") {
        let _ = settings.eval(
            r##"(function(){let tries=0;const timer=setInterval(function(){const link=document.querySelector('.settings-nav a[href="#sec-historico"]');if(link){clearInterval(timer);link.click()}else if(++tries>=80){clearInterval(timer)}},50)})()"##,
        );
    }
    Ok(())
}

fn history_target_label(app: &AppHandle) -> Result<String, String> {
    let id = crate::sessions::history_account_id(app)
        .ok_or_else(|| "No active WhatsApp account is available.".to_string())?;
    let label = accounts::window_label(&id);
    if app.get_webview(&label).is_none() {
        return Err("Open the WhatsApp account before managing its history.".into());
    }
    Ok(label)
}

#[tauri::command]
pub fn get_history_save_media(window: Webview, app: AppHandle) -> Result<bool, String> {
    local(&window, &app)?;
    let Some(id) = crate::sessions::history_account_id(&app) else {
        return Ok(true);
    };
    Ok(accounts::load(&app)
        .accounts
        .into_iter()
        .find(|account| account.id == id)
        .is_none_or(|account| account.history_save_media))
}

/// Import the legacy per-account browser preference once, without allowing the
/// remote page to overwrite a value the user has already set in Settings.
#[tauri::command]
pub fn sync_history_save_media(
    window: Webview,
    app: AppHandle,
    save_media: bool,
) -> Result<(), String> {
    remote(&window)?;
    let Some(id) = accounts::id_from_label(window.label()) else {
        return Err("unknown account".into());
    };
    let _guard = accounts::lock_mutations();
    let mut file = accounts::load(&app);
    let Some(account) = file.accounts.iter_mut().find(|account| account.id == id) else {
        return Err("unknown account".into());
    };
    if !account.history_save_media_configured {
        account.history_save_media = save_media;
        account.history_save_media_configured = true;
        accounts::save(&app, &file).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn set_history_save_media(
    window: Webview,
    app: AppHandle,
    save_media: bool,
) -> Result<(), String> {
    local(&window, &app)?;
    let id = crate::sessions::history_account_id(&app)
        .ok_or_else(|| "No active WhatsApp account is available.".to_string())?;
    let label = accounts::window_label(&id);
    {
        let _guard = accounts::lock_mutations();
        let mut file = accounts::load(&app);
        let Some(account) = file.accounts.iter_mut().find(|account| account.id == id) else {
            return Err("unknown account".into());
        };
        account.history_save_media = save_media;
        account.history_save_media_configured = true;
        accounts::save(&app, &file).map_err(|e| e.to_string())?;
    }
    if let Some(view) = app.get_webview(&label) {
        let value = if save_media { "true" } else { "false" };
        view.eval(format!(
            "(()=>{{let s={{}};try{{s=JSON.parse(localStorage.getItem('wadl-settings')||'{{}}')||{{}}}}catch{{}}s.saveMedia={value};localStorage.setItem('wadl-settings',JSON.stringify(s));if(window.venwhatsapp?.history)window.venwhatsapp.history.setSaveMedia({value})}})()"
        ))
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn queue_history_action(app: &AppHandle, action: &str) -> Result<(), String> {
    let label = history_target_label(app)?;
    let view = app.get_webview(&label).expect("history target checked");
    let action = serde_json::to_string(action).map_err(|e| e.to_string())?;
    view.eval(format!(
        "(()=>{{const q=window.__venwhatsappHistoryQueue||(window.__venwhatsappHistoryQueue=[]);q.push({action});window.venwhatsapp?.history?.drainQueue()}})()"
    ))
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn export_history(window: Webview, app: AppHandle) -> Result<(), String> {
    local(&window, &app)?;
    queue_history_action(&app, "export")
}

#[tauri::command]
pub fn clear_history(window: Webview, app: AppHandle) -> Result<(), String> {
    local(&window, &app)?;
    queue_history_action(&app, "clear")
}

#[tauri::command]
pub fn close_app_panel(window: Webview, app: AppHandle) -> Result<(), String> {
    local(&window, &app)?;
    crate::sessions::close_panel(&app);
    Ok(())
}
#[tauri::command]
pub async fn detach_account(window: Webview, app: AppHandle, id: String) -> Result<(), String> {
    local(&window, &app)?;
    let _g = accounts::lock_mutations();
    #[cfg(windows)]
    {
        crate::sessions::detach(&app, &id)?;
        broadcast(&app);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = id;
        Err(tr("Disponível no Windows").into())
    }
}
#[tauri::command]
pub async fn attach_account(window: Webview, app: AppHandle, id: String) -> Result<(), String> {
    local(&window, &app)?;
    let _g = accounts::lock_mutations();
    #[cfg(windows)]
    {
        crate::sessions::attach(&app, &id)?;
        broadcast(&app);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = id;
        Err(tr("Disponível no Windows").into())
    }
}
#[tauri::command]
pub fn reorder_accounts(window: Webview, app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    local(&window, &app)?;
    let _g = accounts::lock_mutations();
    let mut f = accounts::load(&app);
    accounts::reorder(&mut f, &ids)?;
    accounts::save(&app, &f).map_err(|e| e.to_string())?;
    broadcast(&app);
    crate::tray::rebuild_menu(&app);
    Ok(())
}
#[derive(Serialize)]
pub struct Diagnostics {
    pub version: String,
    pub accounts: Vec<DisplayAccount>,
    pub adapters: HashMap<String, Adapter>,
    pub native: HashMap<String, bool>,
    pub recent: Vec<notify::Notice>,
}
#[tauri::command]
pub fn notification_diagnostics(window: Webview, app: AppHandle) -> Result<Diagnostics, String> {
    local(&window, &app)?;
    let accounts = display_accounts(&app);
    let native = accounts
        .iter()
        .map(|a| {
            (
                a.id.clone(),
                app.state::<notify::Recent>()
                    .native_ready(&accounts::window_label(&a.id)),
            )
        })
        .collect();
    Ok(Diagnostics {
        version: app.package_info().version.to_string(),
        accounts,
        adapters: app.state::<Integration>().0.lock().unwrap().clone(),
        native,
        recent: app.state::<notify::Recent>().records(),
    })
}
#[tauri::command]
pub fn test_notification(window: Webview, app: AppHandle) -> Result<String, String> {
    local(&window, &app)?;
    if !crate::settings::load(&app).notifications {
        return Err(tr("Ative as notificações antes do teste.").into());
    }
    let label = app
        .state::<accounts::ActiveAccount>()
        .lock()
        .unwrap()
        .clone();
    notify::from_account(
        &app,
        &label,
        tr("Teste do Venwhatsapp").as_ref(),
        tr("Se você está vendo este aviso, o Windows exibiu o teste.").as_ref(),
        None,
        notify::Source::Test,
    );
    Ok(tr("Teste solicitado. Confira o banner e a central do Windows; aceitação não confirma exibição.").into_owned())
}
#[tauri::command]
pub fn open_notification_settings(window: Webview, app: AppHandle) -> Result<(), String> {
    local(&window, &app)?;
    #[cfg(windows)]
    {
        use windows::core::w;
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        let result = unsafe {
            ShellExecuteW(
                None,
                w!("open"),
                w!("ms-settings:notifications"),
                None,
                None,
                SW_SHOWNORMAL,
            )
        };
        if result.0 as isize <= 32 {
            return Err(tr("Não foi possível abrir as configurações do Windows").into());
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_origin_allowlist_is_exact() {
        for u in [
            "http://tauri.localhost/index.html",
            "tauri://localhost/index.html",
        ] {
            assert!(local_url(&u.parse().unwrap()));
        }
        for u in [
            "https://web.whatsapp.com",
            "http://localhost:8080",
            "https://tauri.localhost.evil.test",
        ] {
            assert!(!local_url(&u.parse().unwrap()));
        }
    }
}
