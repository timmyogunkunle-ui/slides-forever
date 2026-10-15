//! Connected display discovery (with real monitor names on Windows).

use std::collections::HashMap;

use serde::Serialize;
use tauri::{AppHandle, Manager, Monitor};

#[derive(Serialize, Clone)]
pub struct DisplayInfo {
    /// Stable OS id, e.g. `\\.\DISPLAY2`
    pub id: String,
    /// Number as shown in Windows display settings (1, 2, ...)
    pub number: u32,
    /// Friendly monitor name, e.g. "DELL U2419H"
    pub name: String,
    /// "HDMI", "DisplayPort", "Built-in", ...
    pub connection: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub primary: bool,
    /// The operator window is currently on this display
    #[serde(rename = "hasControl")]
    pub has_control: bool,
}

struct OsName {
    friendly: String,
    connection: String,
}

#[cfg(windows)]
fn os_names() -> HashMap<String, OsName> {
    use windows_sys::Win32::Devices::Display::*;

    let mut map = HashMap::new();
    unsafe {
        let (mut np, mut nm) = (0u32, 0u32);
        if GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut np, &mut nm) != 0 {
            return map;
        }
        let mut paths: Vec<DISPLAYCONFIG_PATH_INFO> = vec![std::mem::zeroed(); np as usize];
        let mut modes: Vec<DISPLAYCONFIG_MODE_INFO> = vec![std::mem::zeroed(); nm as usize];
        if QueryDisplayConfig(
            QDC_ONLY_ACTIVE_PATHS,
            &mut np,
            paths.as_mut_ptr(),
            &mut nm,
            modes.as_mut_ptr(),
            std::ptr::null_mut(),
        ) != 0
        {
            return map;
        }
        paths.truncate(np as usize);
        for p in &paths {
            let mut src: DISPLAYCONFIG_SOURCE_DEVICE_NAME = std::mem::zeroed();
            src.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
            src.header.size = std::mem::size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32;
            src.header.adapterId = p.sourceInfo.adapterId;
            src.header.id = p.sourceInfo.id;
            if DisplayConfigGetDeviceInfo(&mut src.header) != 0 {
                continue;
            }
            let mut tgt: DISPLAYCONFIG_TARGET_DEVICE_NAME = std::mem::zeroed();
            tgt.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME;
            tgt.header.size = std::mem::size_of::<DISPLAYCONFIG_TARGET_DEVICE_NAME>() as u32;
            tgt.header.adapterId = p.targetInfo.adapterId;
            tgt.header.id = p.targetInfo.id;
            if DisplayConfigGetDeviceInfo(&mut tgt.header) != 0 {
                continue;
            }
            let wstr = |s: &[u16]| {
                let end = s.iter().position(|&c| c == 0).unwrap_or(s.len());
                String::from_utf16_lossy(&s[..end])
            };
            let gdi = wstr(&src.viewGdiDeviceName);
            let friendly = wstr(&tgt.monitorFriendlyDeviceName);
            let connection = match tgt.outputTechnology as u32 {
                0 => "VGA",
                4 => "DVI",
                5 => "HDMI",
                6 | 0x8000_0000 | 11 | 13 => "Built-in",
                10 => "DisplayPort",
                12 => "USB-C / DisplayPort",
                15 => "Wireless (Miracast)",
                16 | 17 => "USB / Virtual",
                _ => "",
            }
            .to_string();
            map.entry(gdi).or_insert(OsName { friendly, connection });
        }
    }
    map
}

#[cfg(not(windows))]
fn os_names() -> HashMap<String, OsName> {
    HashMap::new()
}

fn display_number(id: &str, fallback: usize) -> u32 {
    let digits: String = id.chars().rev().take_while(|c| c.is_ascii_digit()).collect::<Vec<_>>().into_iter().rev().collect();
    digits.parse().unwrap_or(fallback as u32 + 1)
}

pub fn monitors(app: &AppHandle) -> Result<Vec<Monitor>, String> {
    app.available_monitors().map_err(|e| e.to_string())
}

pub fn list(app: &AppHandle) -> Result<Vec<DisplayInfo>, String> {
    let mons = monitors(app)?;
    let primary = app.primary_monitor().ok().flatten().and_then(|m| m.name().cloned());
    let control = app
        .get_webview_window("main")
        .and_then(|w| w.current_monitor().ok().flatten())
        .and_then(|m| m.name().cloned());
    let names = os_names();
    let mut out: Vec<DisplayInfo> = mons
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let id = m.name().cloned().unwrap_or_else(|| format!("display-{i}"));
            let number = display_number(&id, i);
            let os = names.get(&id);
            let mut name = os.map(|o| o.friendly.clone()).unwrap_or_default();
            let connection = os.map(|o| o.connection.clone()).unwrap_or_default();
            if name.is_empty() {
                name = if connection == "Built-in" { "Built-in Display".into() } else { format!("Display {number}") };
            }
            DisplayInfo {
                primary: primary.as_ref() == Some(&id),
                has_control: control.as_ref() == Some(&id),
                id,
                number,
                name,
                connection,
                x: m.position().x,
                y: m.position().y,
                width: m.size().width,
                height: m.size().height,
                scale: m.scale_factor(),
            }
        })
        .collect();
    out.sort_by_key(|d| d.number);
    Ok(out)
}
