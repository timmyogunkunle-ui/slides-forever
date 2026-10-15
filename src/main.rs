#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bible;
mod displays;
mod easyworship;
mod library;
mod slides;

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock, RwLock},
    time::Duration,
};

use serde_json::{json, Value};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

const DOCS: &[&str] = &["songs", "media", "groups", "settings", "schedule", "services"];
const PORTABLE_DIR: &str = "SlidesForeverData";

struct AppState {
    /// The user's library folder: songs.json, media.json, settings.json, schedule.json, slides/, bibles/
    lib: RwLock<PathBuf>,
    /// Small file in %APPDATA% remembering where the library is.
    config_path: PathBuf,
    portable: bool,
    default_lib: PathBuf,
    live: Mutex<Value>,
    bibles: OnceLock<RwLock<Vec<bible::Bible>>>,
    /// (window label, display id) for each open live output
    outputs: Mutex<Vec<(String, String)>>,
    started: std::time::Instant,
}

impl AppState {
    fn lib(&self) -> PathBuf {
        self.lib.read().unwrap().clone()
    }
    fn bibles(&self) -> &RwLock<Vec<bible::Bible>> {
        self.bibles.get_or_init(|| RwLock::new(bible::load_all(&self.lib())))
    }
    fn configured(&self) -> bool {
        self.portable || self.config_path.is_file()
    }
}

fn portable_dir() -> Option<PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.join(PORTABLE_DIR);
    dir.is_dir().then_some(dir)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)
}

// ---------- library folder ----------

#[tauri::command]
fn library_info(state: State<AppState>) -> Value {
    json!({
        "dir": state.lib(),
        "defaultDir": state.default_lib,
        "portable": state.portable,
        "configured": state.configured(),
    })
}

#[tauri::command]
async fn pick_folder(window: WebviewWindow, title: String) -> Result<Option<String>, String> {
    Ok(rfd::FileDialog::new()
        .set_title(&title)
        .set_parent(&window)
        .pick_folder()
        .map(|p| p.to_string_lossy().into_owned()))
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for e in fs::read_dir(from)? {
        let e = e?;
        let dest = to.join(e.file_name());
        if e.file_type()?.is_dir() {
            copy_dir(&e.path(), &dest)?;
        } else if !dest.exists() {
            fs::copy(e.path(), dest)?;
        }
    }
    Ok(())
}

/// Use `dir` as the library. If it already holds a library we switch to it;
/// otherwise the current library is copied there first.
#[tauri::command]
async fn set_library(app: AppHandle, state: State<'_, AppState>, dir: String) -> Result<Value, String> {
    if state.portable {
        return Err(format!("Running in portable mode — the library is the {PORTABLE_DIR} folder next to the app."));
    }
    let new = PathBuf::from(&dir);
    fs::create_dir_all(&new).map_err(|e| format!("Can't use that folder: {e}"))?;
    let old = state.lib();
    let existing = new.join("songs.json").is_file();
    if !existing && new != old && old.is_dir() {
        for name in DOCS {
            let f = old.join(format!("{name}.json"));
            if f.is_file() {
                fs::copy(&f, new.join(format!("{name}.json"))).map_err(|e| e.to_string())?;
            }
        }
        for sub in ["slides", "bibles", "imports"] {
            if old.join(sub).is_dir() {
                copy_dir(&old.join(sub), &new.join(sub)).map_err(|e| e.to_string())?;
            }
        }
    }
    if let Some(p) = state.config_path.parent() {
        fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    fs::write(&state.config_path, serde_json::to_vec_pretty(&json!({ "libraryDir": new })).unwrap()).map_err(|e| e.to_string())?;
    *state.lib.write().unwrap() = new.clone();
    let _ = app.asset_protocol_scope().allow_directory(&new, true);
    *state.bibles().write().unwrap() = bible::load_all(&new);
    Ok(json!({ "dir": new, "existing": existing }))
}

#[tauri::command]
fn open_folder(path: String) {
    let _ = std::process::Command::new("explorer").arg(path).spawn();
}

// ---------- documents (songs, media, settings, schedule) ----------

#[tauri::command]
fn load_doc(state: State<AppState>, name: String) -> Value {
    if !DOCS.contains(&name.as_str()) {
        return Value::Null;
    }
    fs::read(state.lib().join(format!("{name}.json")))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null)
}

#[tauri::command]
fn save_doc(state: State<AppState>, name: String, value: Value) -> Result<(), String> {
    if !DOCS.contains(&name.as_str()) {
        return Err("unknown document".into());
    }
    let lib = state.lib();
    fs::create_dir_all(&lib).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?;
    write_atomic(&lib.join(format!("{name}.json")), &bytes).map_err(|e| e.to_string())
}

// ---------- EasyWorship ----------

#[tauri::command]
async fn ew_find() -> Result<Vec<easyworship::EwLibrary>, String> {
    Ok(easyworship::find())
}

/// Read songs from an EasyWorship library folder; with no path, ask the user for a Songs.db.
#[tauri::command]
async fn ew_import(window: WebviewWindow, path: Option<String>) -> Result<Vec<library::ImportedSong>, String> {
    let path = match path {
        Some(p) => PathBuf::from(p),
        None => match rfd::FileDialog::new()
            .set_title("Find EasyWorship's Songs.db (in ...\\Databases\\Data)")
            .add_filter("EasyWorship songs", &["db"])
            .set_directory(r"C:\Users\Public\Documents\Softouch\Easyworship")
            .set_parent(&window)
            .pick_file()
        {
            Some(p) => p,
            None => return Ok(vec![]),
        },
    };
    easyworship::read_library(&path)
}

// ---------- slide groups ----------

#[tauri::command]
async fn pick_slide_files(window: WebviewWindow) -> Result<Vec<String>, String> {
    let mut all: Vec<&str> = slides::PDF_EXT.iter().chain(slides::PPT_EXT).copied().collect();
    all.extend(library::IMAGE_EXT);
    all.extend(library::GIF_EXT);
    Ok(rfd::FileDialog::new()
        .set_title("Make a slide group from PDF, PowerPoint or images")
        .add_filter("PDF, PowerPoint & images", &all)
        .set_parent(&window)
        .pick_files()
        .unwrap_or_default()
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect())
}

#[tauri::command]
async fn make_slide_group(app: AppHandle, state: State<'_, AppState>, id: String, paths: Vec<String>) -> Result<Vec<String>, String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("bad id".into());
    }
    let out = state.lib().join("slides").join(&id);
    let sources: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    let out2 = out.clone();
    let pages = tauri::async_runtime::spawn_blocking(move || slides::build_group(&sources, &out2))
        .await
        .map_err(|e| e.to_string())?;
    let pages = match pages {
        Ok(p) => p,
        Err(e) => {
            let _ = fs::remove_dir_all(&out);
            return Err(e);
        }
    };
    let _ = app.asset_protocol_scope().allow_directory(&out, false);
    Ok(pages.into_iter().map(|p| p.to_string_lossy().into_owned()).collect())
}

#[tauri::command]
fn delete_slide_group(state: State<AppState>, id: String) {
    if !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric()) {
        let _ = fs::remove_dir_all(state.lib().join("slides").join(id));
    }
}

/// Files dragged in from Explorer arrive as bytes; keep a copy in <library>/imports.
#[tauri::command]
fn save_dropped(app: AppHandle, state: State<AppState>, request: tauri::ipc::Request) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected file bytes".into());
    };
    let raw_name = request
        .headers()
        .get("x-name")
        .and_then(|v| v.to_str().ok())
        .map(|s| percent_decode(s))
        .unwrap_or_else(|| "file".into());
    let name: String = Path::new(&raw_name)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into())
        .chars()
        .map(|c| if r#"<>:"/\|?*"#.contains(c) { '_' } else { c })
        .collect();
    let dir = state.lib().join("imports");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut dest = dir.join(&name);
    let mut n = 1;
    while dest.exists() {
        let stem = Path::new(&name).file_stem().unwrap_or_default().to_string_lossy().to_string();
        let ext = Path::new(&name).extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
        dest = dir.join(format!("{stem} ({n}){ext}"));
        n += 1;
    }
    fs::write(&dest, bytes).map_err(|e| e.to_string())?;
    let _ = app.asset_protocol_scope().allow_file(&dest);
    Ok(dest.to_string_lossy().into_owned())
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(Ok(v)) = s.get(i + 1..i + 3).map(|h| u8::from_str_radix(h, 16)) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[tauri::command]
fn parse_song(name: String, text: String) -> library::ImportedSong {
    library::parse_song(&name, &text)
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
    let imported = bible::import_file(&state.lib(), &file)?;
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

/// Window label for the live output on a display, e.g. `\\.\DISPLAY2` -> `output-DISPLAY2`.
fn output_label(display_id: &str) -> String {
    let clean: String = display_id.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    format!("output-{clean}")
}

fn output_windows(app: &AppHandle) -> Vec<WebviewWindow> {
    app.webview_windows().into_iter().filter(|(l, _)| l.starts_with("output-")).map(|(_, w)| w).collect()
}

fn emit_outputs(app: &AppHandle, event: &str, payload: Value) {
    for w in output_windows(app) {
        let _ = app.emit_to(w.label(), event, payload.clone());
    }
}

/// Show the live output on every display in `ids` (first one plays video sound) and close the rest.
#[tauri::command]
async fn open_outputs(app: AppHandle, state: State<'_, AppState>, ids: Vec<String>) -> Result<Vec<String>, String> {
    let mons = displays::monitors(&app)?;
    let targets: Vec<(String, tauri::Monitor)> = ids
        .iter()
        .filter_map(|id| mons.iter().find(|m| m.name() == Some(id)).map(|m| (id.clone(), m.clone())))
        .collect();
    if targets.is_empty() {
        return Err("None of those screens are connected any more.".into());
    }
    let wanted: Vec<String> = targets.iter().map(|(id, _)| output_label(id)).collect();
    for w in output_windows(&app) {
        if !wanted.iter().any(|l| l == w.label()) {
            let _ = w.close();
        }
    }
    let mut opened = Vec::new();
    for (i, (id, m)) in targets.iter().enumerate() {
        let label = output_label(id);
        let primary = i == 0;
        let win = match app.get_webview_window(&label) {
            Some(w) => w,
            None => WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("output.html".into()))
                .title("Slides Forever — Live Output")
                .initialization_script(format!("window.__OUT = {{ primary: {primary} }};"))
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
        let _ = app.emit_to(label.as_str(), "role", json!({ "primary": primary }));
        opened.push(id.clone());
    }
    *state.outputs.lock().unwrap() = targets.iter().map(|(id, _)| (output_label(id), id.clone())).collect();
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.set_focus();
    }
    Ok(opened)
}

#[tauri::command]
fn close_output(app: AppHandle) {
    for w in output_windows(&app) {
        let _ = w.close();
    }
}

/// Esc on an output window closes just that screen.
#[tauri::command]
fn close_this_output(window: WebviewWindow) {
    let _ = window.close();
}

/// Display ids that currently have a live output window.
#[tauri::command]
fn output_open(app: AppHandle, state: State<AppState>) -> Vec<String> {
    let open: Vec<String> = output_windows(&app).iter().map(|w| w.label().to_string()).collect();
    state.outputs.lock().unwrap().iter().filter(|(l, _)| open.contains(l)).map(|(_, id)| id.clone()).collect()
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
    emit_outputs(&app, "live", payload);
}

#[tauri::command]
fn get_live(state: State<AppState>) -> Value {
    state.live.lock().unwrap().clone()
}

/// Video play/pause/restart and similar commands for the output window.
#[tauri::command]
fn live_control(app: AppHandle, command: Value) {
    emit_outputs(&app, "control", command);
}

/// The main window calls this once its UI is ready: hold the splash briefly so the verse
/// can be read, then swap the splash for the main window.
#[tauri::command]
async fn app_ready(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let min = Duration::from_millis(2200);
    let elapsed = state.started.elapsed();
    if elapsed < min {
        tokio_sleep(min - elapsed).await;
    }
    show_main(&app);
    Ok(())
}

async fn tokio_sleep(d: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}

fn show_main(app: &AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        if !main.is_visible().unwrap_or(false) {
            let _ = main.show();
            let _ = main.maximize();
            let _ = main.set_focus();
        }
    }
    if let Some(s) = app.get_webview_window("splash") {
        let _ = s.close();
    }
}

/// Output window reports video progress back to the operator.
#[tauri::command]
fn media_status(app: AppHandle, status: Value) {
    let _ = app.emit_to("main", "media-status", status);
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let config_path = app.path().app_config_dir().unwrap_or_else(|_| PathBuf::from(".")).join("config.json");
            let default_lib = app
                .path()
                .document_dir()
                .or_else(|_| app.path().home_dir())
                .unwrap_or_else(|_| PathBuf::from("."))
                .join("Slides Forever");
            let portable = portable_dir();
            let lib = portable.clone().unwrap_or_else(|| {
                fs::read(&config_path)
                    .ok()
                    .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
                    .and_then(|v| v.get("libraryDir").and_then(|d| d.as_str()).map(PathBuf::from))
                    .unwrap_or_else(|| default_lib.clone())
            });
            // Nothing is written until the user has chosen a library folder (or is in portable mode).
            if portable.is_some() || config_path.is_file() {
                let _ = fs::create_dir_all(&lib);
            }
            let _ = app.asset_protocol_scope().allow_directory(&lib, true);
            app.manage(AppState {
                lib: RwLock::new(lib),
                config_path,
                portable: portable.is_some(),
                default_lib,
                live: Mutex::new(Value::Null),
                bibles: OnceLock::new(),
                outputs: Mutex::new(Vec::new()),
                started: std::time::Instant::now(),
            });
            // Warm up the Bibles in the background so the first search is instant.
            let h = app.handle().clone();
            std::thread::spawn(move || {
                let _ = h.state::<AppState>().bibles();
            });
            // Safety net: never leave the user staring at the splash.
            let h = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(10));
                let h2 = h.clone();
                let _ = h.run_on_main_thread(move || show_main(&h2));
            });
            Ok(())
        })
        .on_window_event(|window, event| match (window.label(), event) {
            ("main", WindowEvent::CloseRequested { .. }) => {
                window.app_handle().exit(0);
            }
            (l, WindowEvent::Destroyed) if l.starts_with("output-") => {
                let app = window.app_handle();
                app.state::<AppState>().outputs.lock().unwrap().retain(|(label, _)| label != l);
                let _ = app.emit_to("main", "output-closed", ());
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            library_info,
            pick_folder,
            set_library,
            open_folder,
            load_doc,
            save_doc,
            ew_find,
            ew_import,
            pick_slide_files,
            make_slide_group,
            delete_slide_group,
            save_dropped,
            parse_song,
            import_songs,
            pick_media,
            register_media,
            bible_list,
            bible_books,
            bible_chapter,
            bible_search,
            import_bible,
            list_displays,
            open_outputs,
            close_this_output,
            app_ready,
            close_output,
            output_open,
            identify_displays,
            set_live,
            get_live,
            live_control,
            media_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Slides Forever");
}
