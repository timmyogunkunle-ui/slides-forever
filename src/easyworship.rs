//! Read songs out of an EasyWorship 6/7/8 library (Songs.db + SongWords.db, lyrics stored as RTF).
//!
//! EasyWorship keeps its library at
//!   C:\Users\Public\Documents\Softouch\Easyworship\<Profile>\v6.1\Databases\Data\
//! (the profile folder is listed in C:\ProgramData\Softouch\Easyworship.v8\Profiles\*.ewp).
//! We only ever read copies of those files, so EasyWorship can stay open.

use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::Serialize;

use crate::library::ImportedSong;

#[derive(Serialize)]
pub struct EwLibrary {
    /// Folder containing Songs.db and SongWords.db
    pub path: String,
    pub songs: usize,
}

const PROGRAM_DATA_DIRS: &[&str] = &[
    r"C:\ProgramData\Softouch\Easyworship.v8\Profiles",
    r"C:\ProgramData\Softouch\Easyworship.v7\Profiles",
    r"C:\ProgramData\Softouch\Easyworship\Profiles",
];

/// Every EasyWorship song library we can find on this PC.
pub fn find() -> Vec<EwLibrary> {
    let mut roots: Vec<PathBuf> = vec![PathBuf::from(r"C:\Users\Public\Documents\Softouch\Easyworship")];
    for dir in PROGRAM_DATA_DIRS {
        let Ok(rd) = fs::read_dir(dir) else { continue };
        for e in rd.flatten() {
            if let Ok(txt) = fs::read_to_string(e.path()) {
                for line in txt.lines() {
                    if let Some(v) = line.strip_prefix("AppInstDataDir=") {
                        roots.push(PathBuf::from(v.trim()));
                    }
                }
            }
        }
    }
    let mut out: Vec<EwLibrary> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for root in roots {
        for data in data_dirs_under(&root, 3) {
            let key = data.to_string_lossy().to_lowercase();
            if !seen.insert(key) {
                continue;
            }
            let songs = read_library(&data).map(|s| s.len()).unwrap_or(0);
            out.push(EwLibrary { path: data.to_string_lossy().into_owned(), songs });
        }
    }
    out
}

/// Find `...\Databases\Data` folders (containing Songs.db) up to `depth` levels below `root`.
fn data_dirs_under(root: &Path, depth: usize) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if root.join("Songs.db").is_file() {
        out.push(root.to_path_buf());
    }
    let d = root.join("Databases").join("Data");
    if d.join("Songs.db").is_file() {
        out.push(d);
    }
    if depth > 0 {
        if let Ok(rd) = fs::read_dir(root) {
            for e in rd.flatten() {
                if e.path().is_dir() {
                    out.extend(data_dirs_under(&e.path(), depth - 1));
                }
            }
        }
    }
    out
}

/// Read all songs from a folder holding Songs.db (+ SongWords.db), or from a Songs.db path.
pub fn read_library(path: &Path) -> Result<Vec<ImportedSong>, String> {
    let dir = if path.is_file() { path.parent().unwrap_or(path).to_path_buf() } else { path.to_path_buf() };
    let songs_db = dir.join("Songs.db");
    let words_db = dir.join("SongWords.db");
    if !songs_db.is_file() {
        return Err(format!("No Songs.db found in {}", dir.display()));
    }
    // Work on private copies so we never lock or alter EasyWorship's files.
    let tmp = std::env::temp_dir().join(format!("slidesforever-ew-{}", std::process::id()));
    fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let s_copy = tmp.join("Songs.db");
    let w_copy = tmp.join("SongWords.db");
    fs::copy(&songs_db, &s_copy).map_err(|e| format!("Could not read Songs.db: {e}"))?;
    let have_words = fs::copy(&words_db, &w_copy).is_ok();

    let result = (|| -> rusqlite::Result<Vec<ImportedSong>> {
        let conn = rusqlite::Connection::open_with_flags(&s_copy, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        if have_words {
            conn.execute("ATTACH DATABASE ?1 AS w", [w_copy.to_string_lossy()])?;
        }
        let sql = if have_words {
            "SELECT s.title, IFNULL(s.author,''), IFNULL(s.copyright,''), IFNULL(s.administrator,''), IFNULL(w.words,'')
             FROM song s LEFT JOIN w.word w ON w.song_id = s.rowid"
        } else {
            "SELECT title, IFNULL(author,''), IFNULL(copyright,''), IFNULL(administrator,''), '' FROM song"
        };
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map([], |r| {
            let words: String = r.get::<_, Option<String>>(4)?.unwrap_or_default();
            let mut copyright: String = r.get(2)?;
            let admin: String = r.get(3)?;
            if !admin.is_empty() {
                if !copyright.is_empty() {
                    copyright.push_str(" • ");
                }
                copyright.push_str(&admin);
            }
            Ok(ImportedSong {
                title: r.get::<_, String>(0)?.trim().to_string(),
                author: r.get(1)?,
                copyright,
                lyrics: rtf_to_lyrics(&words),
            })
        })?;
        rows.collect()
    })();
    let _ = fs::remove_dir_all(&tmp);
    let mut songs = result.map_err(|e| format!("Could not read the EasyWorship library: {e}"))?;
    songs.retain(|s| !s.title.is_empty());
    Ok(songs)
}

fn cp1252(b: u8) -> char {
    const HI: [char; 32] = [
        '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8d}', 'Ž', '\u{8f}',
        '\u{90}', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u{9d}', 'ž', 'Ÿ',
    ];
    if (0x80..0xA0).contains(&b) { HI[(b - 0x80) as usize] } else { b as char }
}

/// Convert EasyWorship RTF to plain lyrics: one line per paragraph, blank line between slides.
pub fn rtf_to_lyrics(rtf: &str) -> String {
    if !rtf.trim_start().starts_with("{\\rtf") {
        return tidy(rtf);
    }
    struct G {
        skip: bool,
        uc: usize,
    }
    const SKIP_DESTS: &[&str] = &["fonttbl", "colortbl", "stylesheet", "info", "pict", "header", "footer", "listtable", "listoverridetable", "themedata", "generator"];
    let chars: Vec<char> = rtf.chars().collect();
    let mut stack: Vec<G> = vec![G { skip: false, uc: 1 }];
    let mut out = String::new();
    let mut i = 0;
    let mut pending_skip = 0usize; // fallback chars to drop after \uN
    while i < chars.len() {
        let c = chars[i];
        match c {
            '{' => {
                let (skip, uc) = stack.last().map(|g| (g.skip, g.uc)).unwrap_or((false, 1));
                stack.push(G { skip, uc });
                i += 1;
            }
            '}' => {
                if stack.len() > 1 {
                    stack.pop();
                }
                i += 1;
            }
            '\\' => {
                i += 1;
                let Some(&n) = chars.get(i) else { break };
                let skip = stack.last().map(|g| g.skip).unwrap_or(false);
                match n {
                    '\\' | '{' | '}' => {
                        if !skip && !take_fallback(&mut pending_skip) {
                            out.push(n);
                        }
                        i += 1;
                    }
                    '\'' => {
                        let hex: String = chars.iter().skip(i + 1).take(2).collect();
                        i += 3;
                        if let Ok(b) = u8::from_str_radix(&hex, 16) {
                            if !skip && !take_fallback(&mut pending_skip) {
                                out.push(cp1252(b));
                            }
                        }
                    }
                    '*' => {
                        if let Some(g) = stack.last_mut() {
                            g.skip = true;
                        }
                        i += 1;
                    }
                    '~' => {
                        if !skip {
                            out.push(' ');
                        }
                        i += 1;
                    }
                    '\r' | '\n' => {
                        if !skip {
                            out.push('\n');
                        }
                        i += 1;
                    }
                    _ if n.is_ascii_alphabetic() => {
                        let start = i;
                        while i < chars.len() && chars[i].is_ascii_alphabetic() {
                            i += 1;
                        }
                        let word: String = chars[start..i].iter().collect();
                        let pstart = i;
                        if i < chars.len() && (chars[i] == '-' || chars[i].is_ascii_digit()) {
                            i += 1;
                            while i < chars.len() && chars[i].is_ascii_digit() {
                                i += 1;
                            }
                        }
                        let param: Option<i32> = chars[pstart..i].iter().collect::<String>().parse().ok();
                        if i < chars.len() && chars[i] == ' ' {
                            i += 1;
                        }
                        if SKIP_DESTS.contains(&word.as_str()) {
                            if let Some(g) = stack.last_mut() {
                                g.skip = true;
                            }
                            continue;
                        }
                        if skip {
                            continue;
                        }
                        match word.as_str() {
                            "par" | "line" | "sect" | "page" => out.push('\n'),
                            "tab" => out.push(' '),
                            "uc" => {
                                if let (Some(g), Some(p)) = (stack.last_mut(), param) {
                                    g.uc = p.max(0) as usize;
                                }
                            }
                            "u" => {
                                if let Some(p) = param {
                                    let code = if p < 0 { (p + 65536) as u32 } else { p as u32 };
                                    if let Some(ch) = char::from_u32(code) {
                                        out.push(ch);
                                    }
                                    pending_skip = stack.last().map(|g| g.uc).unwrap_or(1);
                                }
                            }
                            "emdash" => out.push('—'),
                            "endash" => out.push('–'),
                            "lquote" => out.push('‘'),
                            "rquote" => out.push('’'),
                            "ldblquote" => out.push('“'),
                            "rdblquote" => out.push('”'),
                            "bullet" => out.push('•'),
                            _ => {}
                        }
                    }
                    _ => i += 1,
                }
            }
            '\r' | '\n' => i += 1,
            _ => {
                if !stack.last().map(|g| g.skip).unwrap_or(false) && !take_fallback(&mut pending_skip) {
                    out.push(c);
                }
                i += 1;
            }
        }
    }
    tidy(&out)
}

fn take_fallback(pending: &mut usize) -> bool {
    if *pending > 0 {
        *pending -= 1;
        true
    } else {
        false
    }
}

/// Trim lines and keep at most one blank line between slides.
fn tidy(s: &str) -> String {
    let mut out = String::new();
    let mut blank = false;
    for l in s.replace("\r\n", "\n").replace('\r', "\n").lines() {
        let l = l.trim();
        if l.is_empty() {
            blank = true;
            continue;
        }
        if !out.is_empty() {
            out.push_str(if blank { "\n\n" } else { "\n" });
        }
        blank = false;
        out.push_str(l);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn easyworship_rtf() {
        let rtf = r"{\rtf1\ansi\deff0\sdeasyworship2
{\fonttbl{\f0 Tahoma;}}
{\colortbl ;}
{\pard\sdlistlevel0\qc\qdef\sdewparatemplatestyle101{\*\sdasfactor 1}{\*\sdasbaseline 72}\sdastextstyle101\plain\sdewtemplatestyle101\fs144{\*\sdfsreal 72}{\*\sdfsdef 72}\sdfsauto Verse 1\par}
{\pard\qc\plain Amazing grace how sweet the sound\par}
{\pard\qc\plain That saved a wretch like me\par}
{\pard\qc\plain\par}
{\pard\qc\plain Chorus\par}
{\pard\qc\plain My chains are gone \u8212? I\rquote ve been set free\par}
{\pard\qc\plain caf\'e9 \{ok\}\par}
}";
        assert_eq!(
            rtf_to_lyrics(rtf),
            "Verse 1\nAmazing grace how sweet the sound\nThat saved a wretch like me\n\nChorus\nMy chains are gone — I’ve been set free\ncafé {ok}"
        );
    }

    #[test]
    fn plain_text_passthrough() {
        assert_eq!(rtf_to_lyrics("  a \r\n\r\n\r\n b "), "a\n\nb");
    }
}

#[cfg(test)]
mod local {
    /// Reads the EasyWorship library installed on this PC (run with `cargo test -- --ignored`).
    #[test]
    #[ignore]
    fn read_installed_library() {
        let libs = super::find();
        assert!(!libs.is_empty(), "no EasyWorship library found");
        for l in &libs {
            let songs = super::read_library(std::path::Path::new(&l.path)).unwrap();
            println!("{} -> {} songs", l.path, songs.len());
            for s in songs.iter().take(5) {
                println!("  {:?} / {:?}\n{}", s.title, s.author, s.lyrics);
            }
        }
    }
}
