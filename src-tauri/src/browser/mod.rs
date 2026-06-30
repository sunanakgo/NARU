//! Native embedded browser (PLAN §5). Uses Tauri's (unstable) multi-webview
//! support to attach a real child webview over the browser pane's DOM region,
//! so cross-origin sites render in the system Chromium engine — unlike an
//! iframe. The frontend tracks the pane's bounds and keeps the webview synced.

use std::collections::HashMap;

use parking_lot::Mutex;
use serde::Deserialize;
use tauri::webview::WebviewBuilder;
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Position, Rect, Size, State, WebviewUrl,
};

/// Off-screen position used to "hide" a child webview (inactive tab / modal).
const OFFSCREEN: f64 = -32000.0;

#[derive(Default)]
pub struct BrowserManager {
    views: Mutex<HashMap<String, tauri::Webview>>,
}

#[derive(Deserialize)]
pub struct BrowserBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn rect(x: f64, y: f64, w: f64, h: f64) -> Rect {
    Rect {
        position: Position::Logical(LogicalPosition::new(x, y)),
        size: Size::Logical(LogicalSize::new(w.max(0.0), h.max(0.0))),
    }
}

fn parse_browser_url(url: &str) -> Result<tauri::Url, String> {
    let parsed: tauri::Url = url.parse().map_err(|_| "invalid url".to_string())?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed),
        scheme => Err(format!("unsupported browser url scheme: {scheme}")),
    }
}

#[tauri::command]
pub async fn browser_open(
    app: AppHandle,
    manager: State<'_, BrowserManager>,
    label: String,
    url: String,
    bounds: BrowserBounds,
) -> Result<(), String> {
    // Already open → just reposition (and navigate if the URL changed).
    {
        let views = manager.views.lock();
        if let Some(view) = views.get(&label) {
            let _ = view.set_bounds(rect(bounds.x, bounds.y, bounds.width, bounds.height));
            return Ok(());
        }
    }

    let window = app
        .get_window("main")
        .ok_or_else(|| "no main window".to_string())?;
    let parsed = parse_browser_url(&url)?;

    let builder = WebviewBuilder::new(label.clone(), WebviewUrl::External(parsed));
    let view = window
        .add_child(
            builder,
            Position::Logical(LogicalPosition::new(bounds.x, bounds.y)),
            Size::Logical(LogicalSize::new(
                bounds.width.max(0.0),
                bounds.height.max(0.0),
            )),
        )
        .map_err(|e| e.to_string())?;

    manager.views.lock().insert(label, view);
    Ok(())
}

#[tauri::command]
pub fn browser_set_bounds(
    manager: State<'_, BrowserManager>,
    label: String,
    bounds: BrowserBounds,
) -> Result<(), String> {
    if let Some(view) = manager.views.lock().get(&label) {
        let _ = view.set_bounds(rect(bounds.x, bounds.y, bounds.width, bounds.height));
    }
    Ok(())
}

#[tauri::command]
pub fn browser_navigate(
    manager: State<'_, BrowserManager>,
    label: String,
    url: String,
) -> Result<(), String> {
    if let Some(view) = manager.views.lock().get(&label) {
        let parsed = parse_browser_url(&url)?;
        view.navigate(parsed).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn browser_hide(manager: State<'_, BrowserManager>, label: String) -> Result<(), String> {
    if let Some(view) = manager.views.lock().get(&label) {
        // Park off-screen (keeps the page alive); next set_bounds restores it.
        let _ = view.set_position(Position::Logical(LogicalPosition::new(OFFSCREEN, OFFSCREEN)));
    }
    Ok(())
}

#[tauri::command]
pub fn browser_close(manager: State<'_, BrowserManager>, label: String) -> Result<(), String> {
    if let Some(view) = manager.views.lock().remove(&label) {
        let _ = view.close();
    }
    Ok(())
}
