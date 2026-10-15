#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bible;
mod displays;
mod library;

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock, RwLock},
    time::Duration,
};

use serde_json::Value;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

const DOCS: &[&str] = &["songs", "media", "settings", "schedule"];

struct AppState {
    data_dir: PathBuf,
    live: Mutex<Value>,
    bibles: OnceLock<RwLock<Vec<bible::Bible>>>,
}

impl AppState {
    fn bibles(&self) -> &RwLock<Vec<bible::Bible>> {
        self.bibles.get_or_init(|| RwLock::new(bible::load_all(&self.data_dir)))
    }
}

/// `ShineData` next to the exe = portable mode (run from a USB stick); otherwise %APPDATA%.
fn resolve_data_dir(app: &AppHandle) -> PathBuf {
    if let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.join("ShineData"))) {
        if dir.is_dir() {
            return dir;
        }
    }
    app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("ShineData"))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)
}

// ---------- documents (songs, media, settings, schedule) ----------

#[tauri::command]
fn load_doc(state: State<AppState>, name: String) -> Value {
    if !DOCS.contains(&name.as_str()) {
        return Value::Null;
    }
    fs::read(state.data_dir.join(format!("{name}.json")))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null)
}

#[tauri::command]
fn save_doc(state: State<AppState>, name: String, value: Value) -> Result<(), String> {
    if !DOCS.contains(&name.as_str()) {
        return Err("unknown document".into());
    }
    fs::create_dir_all(&state.data_dir).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?;
    write_atomic(&state.data_dir.join(format!("{name}.json")), &bytes).map_err(|e| e.to_string())
}

#[tauri::command]
fn data_folder(state: State<AppState>) -> String {
    state.data_dir.to_string_lossy().into_owned()
}

// ---------- imports ----------

#[tauri::command]
async fn import_songs(window: WebviewWindow) -> Result<Vec<library::ImportedSong>, String> {
    let Some(files) = rfd::FileDialog::new()
        .set_title("Import songs (.txt)")
        .add_filter("Song text files", &["txt"])
        .set_parent(&window)
        .pick_files()
    else {
        return Ok(vec![]);
    };
    let mut out = Vec::new();
    for f in files {
        let bytes = fs::read(&f).map_err(|e| format!("{}: {e}", f.display()))?;
        let stem = f.file_stem().unwrap_or_default().to_string_lossy().to_string();
        let song = library::parse_song(&stem, &library::decode_text(&bytes));
        if !song.lyrics.is_empty() {
            out.push(song);
        }
    }
    Ok(out)
}

#[tauri::command]
async fn pick_media(app: AppHandle, window: WebviewWindow) -> Result<Vec<library::MediaFile>, String> {
    let all: Vec<&str> = library::IMAGE_EXT.iter().chain(library::GIF_EXT).chain(library::VIDEO_EXT).copied().collect();
    let Some(files) = rfd::FileDialog::new()
        .set_title("Add images, videos and GIFs")
        .add_filter("Images, videos & GIFs", &all)
        .add_filter("Images", library::IMAGE_EXT)
        .add_filter("Videos", library::VIDEO_EXT)
        .add_filter("GIFs", library::GIF_EXT)
        .set_parent(&window)
        .pick_files()
    else {
        return Ok(vec![]);
    };
    let scope = app.asset_protocol_scope();
    Ok(files
        .into_iter()
        .filter_map(|p| {
            let kind = library::media_kind(&p)?;
            let _ = scope.allow_file(&p);
            Some(library::MediaFile {
                name: p.file_stem().unwrap_or_default().to_string_lossy().to_string(),
                path: p.to_string_lossy().into_owned(),
                kind,
            })
        })
        .collect())
}

/// Lets the webview load previously imported media files from wherever they live on disk.
#[tauri::command]
fn register_media(app: AppHandle, paths: Vec<String>) -> Vec<String> {
    let scope = app.asset_protocol_scope();
    let mut missing = Vec::new();
    for p in paths {
        let pb = PathBuf::from(&p);
        if pb.exists() {
            let _ = scope.allow_file(&pb);
        } else {
            missing.push(p);
        }
    }
    missing
}

// ---------- bible ----------

#[tauri::command]
async fn bible_list(state: State<'_, AppState>) -> Result<Vec<bible::BibleInfo>, String> {
    Ok(state.bibles().read().unwrap().iter().map(bible::info).collect())
}

#[tauri::command]
async fn bible_books(state: State<'_, AppState>, bible: usize) -> Result<Vec<bible::BookInfo>, String> {
    let b = state.bibles().read().unwrap();
    Ok(b.get(bible).map(bible::books).unwrap_or_default())
}

#[tauri::command]
async fn bible_chapter(state: State<'_, AppState>, bible: usize, book: usize, chapter: u32) -> Result<Vec<bible::Verse>, String> {
    let b = state.bibles().read().unwrap();
    Ok(b.get(bible).map(|bb| bible::chapter(bb, book, chapter)).unwrap_or_default())
}

#[tauri::command]
async fn bible_search(state: State<'_, AppState>, bible: usize, query: String) -> Result<bible::SearchResult, String> {
    let b = state.bibles().read().unwrap();
    let bb = b.get(bible).ok_or("Bible not found")?;
    Ok(bible::search(bb, &query))
}

#[tauri::command]
async fn import_bible(state: State<'_, AppState>, window: WebviewWindow) -> Result<Option<String>, String> {
    let Some(file) = rfd::FileDialog::new()
        .set_title("Import a Bible (JSON or text)")
        .add_filter("Bible files", &["json", "txt"])
        .set_parent(&window)
        .pick_file()
    else {
        return Ok(None);
    };
    let imported = bible::import_file(&state.data_dir, &file)?;
    let name = imported.name.clone();
    let mut list = state.bibles().write().unwrap();
    list.retain(|b| b.id != imported.id);
    list.push(imported);
    Ok(Some(name))
}

// ---------- displays & output ----------

#[tauri::command]
fn list_displays(app: AppHandle) -> Result<Vec<displays::DisplayInfo>, String> {
    displays::list(&app)
}

#[tauri::command]
async fn open_output(app: AppHandle, id: String) -> Result<String, String> {
    let mons = displays::monitors(&app)?;
    let m = mons
        .iter()
        .find(|m| m.name() == Some(&id))
        .or_else(|| mons.first())
        .ok_or("No displays found")?
        .clone();
    let win = match app.get_webview_window("output") {
        Some(w) => w,
        None => WebviewWindowBuilder::new(&app, "output", WebviewUrl::App("output.html".into()))
            .title("Shine — Live Output")
            .decorations(false)
            .resizable(false)
            .visible(false)
            .focused(false)
            .build()
            .map_err(|e| e.to_string())?,
    };
    let _ = win.set_fullscreen(false);
    win.set_position(PhysicalPosition::new(m.position().x, m.position().y)).map_err(|e| e.to_string())?;
    win.set_size(PhysicalSize::new(m.size().width, m.size().height)).map_err(|e| e.to_string())?;
    let _ = win.set_fullscreen(true);
    let _ = win.show();
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.set_focus();
    }
    Ok(m.name().cloned().unwrap_or(id))
}

#[tauri::command]
fn close_output(app: AppHandle) {
    if let Some(w) = app.get_webview_window("output") {
        let _ = w.close();
    }
}

#[tauri::command]
fn output_open(app: AppHandle) -> bool {
    app.get_webview_window("output").is_some()
}

/// Flash a big number on every screen, like Windows "Identify".
#[tauri::command]
async fn identify_displays(app: AppHandle) -> Result<(), String> {
    for d in displays::list(&app)? {
        let label = format!("identify-{}", d.number);
        if app.get_webview_window(&label).is_some() {
            continue;
        }
        let size = (260.0 * d.scale) as u32;
        let w = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("identify.html".into()))
            .initialization_script(format!(
                "window.__IDENT = {};",
                serde_json::json!({"number": d.number, "name": d.name, "w": d.width, "h": d.height})
            ))
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .focused(false)
            .visible(false)
            .build()
            .map_err(|e| e.to_string())?;
        let _ = w.set_size(PhysicalSize::new(size, size));
        let _ = w.set_position(PhysicalPosition::new(d.x + (40.0 * d.scale) as i32, d.y + (40.0 * d.scale) as i32));
        let _ = w.show();
        let w2 = w.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(2600));
            let _ = w2.close();
        });
    }
    Ok(())
}

#[tauri::command]
fn set_live(app: AppHandle, state: State<AppState>, payload: Value) {
    *state.live.lock().unwrap() = payload.clone();
    let _ = app.emit_to("output", "live", payload);
}

#[tauri::command]
fn get_live(state: State<AppState>) -> Value {
    state.live.lock().unwrap().clone()
}

/// Video play/pause/restart and similar commands for the output window.
#[tauri::command]
fn live_control(app: AppHandle, command: Value) {
    let _ = app.emit_to("output", "control", command);
}

/// Output window reports video progress back to the operator.
#[tauri::command]
fn media_status(app: AppHandle, status: Value) {
    let _ = app.emit_to("main", "media-status", status);
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = resolve_data_dir(app.handle());
            let _ = fs::create_dir_all(&data_dir);
            let _ = app.asset_protocol_scope().allow_directory(&data_dir, true);
            app.manage(AppState { data_dir, live: Mutex::new(Value::Null), bibles: OnceLock::new() });
            // Warm up the Bibles in the background so the first search is instant.
            let h = app.handle().clone();
            std::thread::spawn(move || {
                let _ = h.state::<AppState>().bibles();
            });
            Ok(())
        })
        .on_window_event(|window, event| match (window.label(), event) {
            ("main", WindowEvent::CloseRequested { .. }) => {
                window.app_handle().exit(0);
            }
            ("output", WindowEvent::Destroyed) => {
                let _ = window.app_handle().emit_to("main", "output-closed", ());
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            load_doc,
            save_doc,
            data_folder,
            import_songs,
            pick_media,
            register_media,
            bible_list,
            bible_books,
            bible_chapter,
            bible_search,
            import_bible,
            list_displays,
            open_output,
            close_output,
            output_open,
            identify_displays,
            set_live,
            get_live,
            live_control,
            media_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Shine");
}
