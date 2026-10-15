//! Song text import and media file classification.

use std::path::Path;

use serde::Serialize;

#[derive(Serialize)]
pub struct ImportedSong {
    pub title: String,
    pub author: String,
    pub copyright: String,
    pub lyrics: String,
}

#[derive(Serialize)]
pub struct MediaFile {
    pub path: String,
    pub name: String,
    pub kind: &'static str,
}

pub const IMAGE_EXT: &[&str] = &["png", "jpg", "jpeg", "bmp", "webp", "avif"];
pub const GIF_EXT: &[&str] = &["gif"];
pub const VIDEO_EXT: &[&str] = &["mp4", "m4v", "webm", "mov", "ogv"];

pub fn media_kind(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_string_lossy().to_lowercase();
    if IMAGE_EXT.contains(&ext.as_str()) {
        Some("image")
    } else if GIF_EXT.contains(&ext.as_str()) {
        Some("gif")
    } else if VIDEO_EXT.contains(&ext.as_str()) {
        Some("video")
    } else {
        None
    }
}

/// Decode a text file that may be UTF-8, UTF-16 (with BOM) or Windows-1252.
pub fn decode_text(bytes: &[u8]) -> String {
    if let Some(b) = bytes.strip_prefix(b"\xEF\xBB\xBF") {
        return String::from_utf8_lossy(b).into_owned();
    }
    if bytes.len() >= 2 && (bytes[..2] == [0xFF, 0xFE] || bytes[..2] == [0xFE, 0xFF]) {
        let le = bytes[0] == 0xFF;
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) })
            .collect();
        return String::from_utf16_lossy(&units);
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        // Older song files are usually ANSI; map bytes 1:1 (close enough for lyrics, fixes smart quotes below).
        Err(_) => bytes
            .iter()
            .map(|&b| match b {
                0x91 | 0x92 => '\'',
                0x93 | 0x94 => '"',
                0x96 | 0x97 => '-',
                0x85 => '…',
                _ => b as char,
            })
            .collect(),
    }
}

fn meta_value<'a>(line: &'a str, keys: &[&str]) -> Option<&'a str> {
    let lower = line.to_lowercase();
    for k in keys {
        if lower.starts_with(k) {
            let rest = line.get(k.len()..)?;
            let rest = rest.trim_start_matches([':', ' ', '\t', '-']);
            return Some(rest.trim());
        }
    }
    None
}

/// Turn a plain .txt song into title + lyrics. Stanzas are separated by blank lines.
/// Recognises optional `Title:`, `Author:` and `Copyright:`/`CCLI` lines at the top.
pub fn parse_song(file_name: &str, content: &str) -> ImportedSong {
    let content = content.replace("\r\n", "\n").replace('\r', "\n");
    let mut title = file_name.to_string();
    let mut author = String::new();
    let mut copyright = String::new();
    let mut body = Vec::new();
    let mut in_header = true;
    for line in content.lines() {
        if in_header {
            if let Some(v) = meta_value(line, &["title:"]) {
                title = v.to_string();
                continue;
            }
            if let Some(v) = meta_value(line, &["author", "words and music by", "written by"]) {
                author = v.to_string();
                continue;
            }
            if let Some(v) = meta_value(line, &["copyright", "©", "ccli"]) {
                if !copyright.is_empty() {
                    copyright.push_str(" • ");
                }
                copyright.push_str(v);
                continue;
            }
            if line.trim().is_empty() && body.is_empty() {
                continue;
            }
            in_header = false;
        }
        body.push(line.trim_end().to_string());
    }
    // Collapse runs of blank lines and trim.
    let mut lyrics = String::new();
    let mut blank = false;
    for l in body {
        if l.trim().is_empty() {
            blank = true;
            continue;
        }
        if blank && !lyrics.is_empty() {
            lyrics.push_str("\n\n");
        } else if !lyrics.is_empty() {
            lyrics.push('\n');
        }
        blank = false;
        lyrics.push_str(l.trim());
    }
    ImportedSong { title, author, copyright, lyrics }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_song_text() {
        let s = parse_song(
            "Amazing Grace",
            "Title: Amazing Grace\r\nAuthor: John Newton\r\n\r\nVerse 1\r\nAmazing grace\r\nhow sweet the sound\r\n\r\n\r\nChorus\r\nMy chains are gone\r\n",
        );
        assert_eq!(s.title, "Amazing Grace");
        assert_eq!(s.author, "John Newton");
        assert_eq!(s.lyrics, "Verse 1\nAmazing grace\nhow sweet the sound\n\nChorus\nMy chains are gone");
    }

    #[test]
    fn decodes_utf16_and_ansi() {
        let utf16: Vec<u8> = [0xFF, 0xFE].into_iter().chain("Hi".encode_utf16().flat_map(|u| u.to_le_bytes())).collect();
        assert_eq!(decode_text(&utf16), "Hi");
        assert_eq!(decode_text(&[0x93, b'A', 0x94]), "\"A\"");
    }
}
