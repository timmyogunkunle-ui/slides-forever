//! Bible storage, reference parsing ("Jn 3:16-18") and keyword search.

use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::OnceLock,
};

use regex::Regex;
use serde::{Deserialize, Serialize};

static KJV_GZ: &[u8] = include_bytes!("../bibles/KJV.json.gz");
static BSB_GZ: &[u8] = include_bytes!("../bibles/BSB.json.gz");

pub const BOOKS: [&str; 66] = [
    "Genesis", "Exodus", "Leviticus", "Numbers", "Deuteronomy", "Joshua", "Judges", "Ruth",
    "1 Samuel", "2 Samuel", "1 Kings", "2 Kings", "1 Chronicles", "2 Chronicles", "Ezra",
    "Nehemiah", "Esther", "Job", "Psalms", "Proverbs", "Ecclesiastes", "Song of Solomon",
    "Isaiah", "Jeremiah", "Lamentations", "Ezekiel", "Daniel", "Hosea", "Joel", "Amos",
    "Obadiah", "Jonah", "Micah", "Nahum", "Habakkuk", "Zephaniah", "Haggai", "Zechariah",
    "Malachi", "Matthew", "Mark", "Luke", "John", "Acts", "Romans", "1 Corinthians",
    "2 Corinthians", "Galatians", "Ephesians", "Philippians", "Colossians", "1 Thessalonians",
    "2 Thessalonians", "1 Timothy", "2 Timothy", "Titus", "Philemon", "Hebrews", "James",
    "1 Peter", "2 Peter", "1 John", "2 John", "3 John", "Jude", "Revelation",
];

/// Extra short forms people type that are not simple prefixes of the book name.
const ALIASES: &[(&str, usize)] = &[
    ("jn", 42), ("jhn", 42), ("mt", 39), ("mk", 40), ("mrk", 40), ("lk", 41), ("luk", 41),
    ("ps", 18), ("psa", 18), ("psalm", 18), ("pss", 18), ("pr", 19), ("prv", 19),
    ("ecc", 20), ("qoh", 20), ("sos", 21), ("songofsongs", 21), ("song", 21), ("canticles", 21),
    ("jdg", 6), ("jdgs", 6), ("judg", 6), ("dt", 4), ("ex", 1), ("exo", 1), ("gn", 0),
    ("lv", 2), ("nm", 3), ("ezk", 25), ("jl", 28), ("jas", 58), ("jm", 58), ("jam", 58),
    ("php", 49), ("phil", 49), ("phlm", 56), ("phm", 56), ("philem", 56), ("rv", 65),
    ("rev", 65), ("revelations", 65), ("revelationofjohn", 65), ("hb", 57), ("jud", 64),
    ("1jn", 61), ("2jn", 62), ("3jn", 63), ("1pt", 59), ("2pt", 60), ("1th", 51), ("2th", 52),
    ("1tm", 53), ("2tm", 54), ("1sm", 8), ("2sm", 9), ("1kgs", 10), ("2kgs", 11),
    ("1chr", 12), ("2chr", 13), ("1cor", 45), ("2cor", 46), ("zep", 35), ("zec", 37),
    ("mal", 38), ("mic", 32), ("nah", 33), ("hab", 34), ("hag", 36), ("jon", 31), ("ob", 30),
    ("est", 16), ("neh", 15), ("lam", 24), ("dan", 26), ("hos", 27), ("am", 29), ("ac", 43),
    ("rm", 44), ("ro", 44), ("ga", 47), ("ep", 48), ("col", 50), ("ti", 55), ("tit", 55),
];

#[derive(Deserialize)]
struct SrcBible {
    #[serde(default)]
    translation: String,
    books: Vec<SrcBook>,
}
#[derive(Deserialize)]
struct SrcBook {
    name: String,
    chapters: Vec<SrcChapter>,
}
#[derive(Deserialize)]
struct SrcChapter {
    chapter: u32,
    verses: Vec<SrcVerse>,
}
#[derive(Deserialize)]
struct SrcVerse {
    verse: u32,
    text: String,
}

/// Alternative layout: `[{"name": "...", "chapters": [["v1", "v2"], ...]}]`
#[derive(Deserialize)]
struct SimpleBook {
    #[serde(default)]
    name: String,
    #[serde(default)]
    abbrev: String,
    chapters: Vec<Vec<String>>,
}

pub struct Book {
    pub name: String,
    /// chapters[c] = list of (verse number, text, lowercase text)
    pub chapters: Vec<Vec<(u32, String, String)>>,
}

pub struct Bible {
    pub id: String,
    pub name: String,
    pub books: Vec<Book>,
}

#[derive(Serialize)]
pub struct BibleInfo {
    pub id: String,
    pub name: String,
}

#[derive(Serialize)]
pub struct BookInfo {
    pub name: String,
    pub chapters: usize,
}

#[derive(Serialize, Clone)]
pub struct Verse {
    pub book: usize,
    #[serde(rename = "bookName")]
    pub book_name: String,
    pub chapter: u32,
    pub verse: u32,
    pub text: String,
}

#[derive(Serialize)]
pub struct SearchResult {
    /// "reference" when the query parsed as a reference, otherwise "text"
    pub kind: &'static str,
    pub title: String,
    pub verses: Vec<Verse>,
    /// for references: the verses that were asked for (whole chapter is returned for context)
    pub selected: Vec<u32>,
}

fn clean_text(t: &str) -> String {
    // KJV marks translator-added words with [brackets]; projection does not need them.
    let t = t.replace(['[', ']'], "");
    t.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn build(id: &str, name: String, books: Vec<(String, Vec<Vec<(u32, String)>>)>) -> Bible {
    let canonical = books.len() == 66;
    let books = books
        .into_iter()
        .enumerate()
        .map(|(i, (bname, chapters))| Book {
            name: if canonical { BOOKS[i].to_string() } else { bname },
            chapters: chapters
                .into_iter()
                .map(|vs| {
                    vs.into_iter()
                        .map(|(n, t)| {
                            let t = clean_text(&t);
                            let l = t.to_lowercase();
                            (n, t, l)
                        })
                        .collect()
                })
                .collect(),
        })
        .collect();
    Bible { id: id.to_string(), name, books }
}

fn parse_json(id: &str, fallback_name: &str, bytes: &[u8]) -> Result<Bible, String> {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    if let Ok(src) = serde_json::from_slice::<SrcBible>(bytes) {
        let name = if src.translation.is_empty() { fallback_name.to_string() } else { src.translation };
        let books = src
            .books
            .into_iter()
            .map(|b| {
                let mut chapters: Vec<Vec<(u32, String)>> = Vec::new();
                for c in b.chapters {
                    let idx = c.chapter.max(1) as usize - 1;
                    if chapters.len() <= idx {
                        chapters.resize(idx + 1, Vec::new());
                    }
                    chapters[idx] = c.verses.into_iter().map(|v| (v.verse, v.text)).collect();
                }
                (b.name, chapters)
            })
            .collect();
        return Ok(build(id, name, books));
    }
    let simple: Vec<SimpleBook> =
        serde_json::from_slice(bytes).map_err(|e| format!("Not a recognised Bible file: {e}"))?;
    let books = simple
        .into_iter()
        .map(|b| {
            let name = if b.name.is_empty() { b.abbrev } else { b.name };
            let chapters = b
                .chapters
                .into_iter()
                .map(|vs| vs.into_iter().enumerate().map(|(i, t)| (i as u32 + 1, t)).collect())
                .collect();
            (name, chapters)
        })
        .collect();
    Ok(build(id, fallback_name.to_string(), books))
}

/// Plain text: one verse per line, `Book Chapter:Verse Text` (e.g. `1 John 4:8 He that loveth not...`).
fn parse_txt(id: &str, name: &str, text: &str) -> Result<Bible, String> {
    let re = Regex::new(r"^\s*((?:[1-3]\s*)?[^\d:]+?)\s+(\d+)\s*:\s*(\d+)\s+(.+)$").unwrap();
    let mut books: Vec<(String, Vec<Vec<(u32, String)>>)> = Vec::new();
    for line in text.lines() {
        let Some(c) = re.captures(line) else { continue };
        let bname = c[1].trim().to_string();
        let ch: usize = c[2].parse().unwrap_or(1);
        let v: u32 = c[3].parse().unwrap_or(1);
        if books.last().map(|b| b.0 != bname).unwrap_or(true) {
            books.push((bname, Vec::new()));
        }
        let chapters = &mut books.last_mut().unwrap().1;
        if chapters.len() < ch {
            chapters.resize(ch, Vec::new());
        }
        chapters[ch - 1].push((v, c[4].to_string()));
    }
    if books.is_empty() {
        return Err("No verses found. Use one verse per line like: John 3:16 For God so loved...".into());
    }
    Ok(build(id, name.to_string(), books))
}

fn gunzip(b: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(b).read_to_end(&mut out).expect("embedded bible is valid gzip");
    out
}

pub fn load_all(data_dir: &Path) -> Vec<Bible> {
    let mut v = vec![
        parse_json("KJV", "King James Version", &gunzip(KJV_GZ)).expect("KJV"),
        parse_json("BSB", "Berean Standard Bible", &gunzip(BSB_GZ)).expect("BSB"),
    ];
    v[0].name = "KJV — King James Version".into();
    v[1].name = "BSB — Berean Standard Bible".into();
    if let Ok(rd) = fs::read_dir(bibles_dir(data_dir)) {
        let mut paths: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
        paths.sort();
        for p in paths {
            if p.extension().map(|e| e == "json").unwrap_or(false) {
                let stem = p.file_stem().unwrap_or_default().to_string_lossy().to_string();
                if let Ok(bytes) = fs::read(&p) {
                    if let Ok(mut b) = parse_json(&stem, &stem, &bytes) {
                        b.name = stem.clone();
                        v.push(b);
                    }
                }
            }
        }
    }
    v
}

pub fn bibles_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("bibles")
}

/// Validate a user-supplied Bible and save it (as JSON) into the data folder.
pub fn import_file(data_dir: &Path, path: &Path) -> Result<Bible, String> {
    let stem = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let is_txt = path.extension().map(|e| e.eq_ignore_ascii_case("txt")).unwrap_or(false);
    let mut bible = if is_txt {
        parse_txt(&stem, &stem, &crate::library::decode_text(&bytes))?
    } else {
        parse_json(&stem, &stem, &bytes)?
    };
    bible.name = stem.clone();
    // Persist in the standard {translation, books:[{name, chapters:[{chapter, verses:[...]}]}]} layout.
    let out = serde_json::json!({
        "translation": stem,
        "books": bible.books.iter().map(|b| serde_json::json!({
            "name": b.name,
            "chapters": b.chapters.iter().enumerate().map(|(i, vs)| serde_json::json!({
                "chapter": i + 1,
                "verses": vs.iter().map(|(n, t, _)| serde_json::json!({"verse": n, "text": t})).collect::<Vec<_>>()
            })).collect::<Vec<_>>()
        })).collect::<Vec<_>>()
    });
    let dir = bibles_dir(data_dir);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join(format!("{stem}.json")), serde_json::to_vec(&out).unwrap()).map_err(|e| e.to_string())?;
    Ok(bible)
}

fn norm(s: &str) -> String {
    let s = s.to_lowercase();
    let s = s
        .replace("iii ", "3").replace("ii ", "2").replace("i ", "1")
        .replace("first ", "1").replace("second ", "2").replace("third ", "3");
    s.chars().filter(|c| c.is_alphanumeric()).collect()
}

fn find_book(bible: &Bible, raw: &str) -> Option<usize> {
    let q = norm(raw.trim_end_matches('.'));
    if q.is_empty() {
        return None;
    }
    let names: Vec<String> = bible.books.iter().map(|b| norm(&b.name)).collect();
    if let Some(i) = names.iter().position(|n| *n == q) {
        return Some(i);
    }
    if bible.books.len() == 66 {
        if let Some(i) = BOOKS.iter().position(|n| norm(n) == q) {
            return Some(i);
        }
        if let Some((_, i)) = ALIASES.iter().find(|(a, _)| *a == q) {
            return Some(*i);
        }
    }
    if let Some(i) = names.iter().position(|n| n.starts_with(&q)) {
        return Some(i);
    }
    if bible.books.len() == 66 {
        return BOOKS.iter().position(|n| norm(n).starts_with(&q));
    }
    None
}

fn ref_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)^\s*((?:[1-3]|i{1,3})?\s*[a-z][a-z .]*?)\s*(\d+)(?:\s*[:.\s]\s*(\d+)(?:\s*[-–]\s*(\d+))?)?\s*$").unwrap()
    })
}

fn verse_of(bible: &Bible, b: usize, c: usize, v: &(u32, String, String)) -> Verse {
    Verse { book: b, book_name: bible.books[b].name.clone(), chapter: c as u32 + 1, verse: v.0, text: v.1.clone() }
}

pub fn chapter(bible: &Bible, book: usize, ch: u32) -> Vec<Verse> {
    let Some(b) = bible.books.get(book) else { return vec![] };
    let ci = ch.max(1) as usize - 1;
    b.chapters.get(ci).map(|vs| vs.iter().map(|v| verse_of(bible, book, ci, v)).collect()).unwrap_or_default()
}

pub fn search(bible: &Bible, query: &str) -> SearchResult {
    let q = query.trim();
    if let Some(c) = ref_regex().captures(q) {
        if let Some(book) = find_book(bible, &c[1]) {
            let ch: u32 = c[2].parse().unwrap_or(1);
            let nchap = bible.books[book].chapters.len() as u32;
            let ch = ch.clamp(1, nchap.max(1));
            let verses = chapter(bible, book, ch);
            let start: Option<u32> = c.get(3).and_then(|m| m.as_str().parse().ok());
            let end: Option<u32> = c.get(4).and_then(|m| m.as_str().parse().ok());
            let selected: Vec<u32> = match (start, end) {
                (Some(s), Some(e)) => verses.iter().map(|v| v.verse).filter(|n| *n >= s && *n <= e.max(s)).collect(),
                (Some(s), None) => verses.iter().map(|v| v.verse).filter(|n| *n == s).collect(),
                _ => vec![],
            };
            let title = format!("{} {}", bible.books[book].name, ch);
            return SearchResult { kind: "reference", title, verses, selected };
        }
    }
    // Keyword search: every word must appear (in any order).
    let words: Vec<String> = q.to_lowercase().split_whitespace().map(|w| w.to_string()).collect();
    let mut out = Vec::new();
    if !words.is_empty() {
        'outer: for (bi, b) in bible.books.iter().enumerate() {
            for (ci, vs) in b.chapters.iter().enumerate() {
                for v in vs {
                    if words.iter().all(|w| v.2.contains(w.as_str())) {
                        out.push(verse_of(bible, bi, ci, v));
                        if out.len() >= 400 {
                            break 'outer;
                        }
                    }
                }
            }
        }
    }
    SearchResult { kind: "text", title: format!("{} matches", out.len()), verses: out, selected: vec![] }
}

pub fn info(b: &Bible) -> BibleInfo {
    BibleInfo { id: b.id.clone(), name: b.name.clone() }
}

pub fn books(b: &Bible) -> Vec<BookInfo> {
    b.books.iter().map(|bk| BookInfo { name: bk.name.clone(), chapters: bk.chapters.len() }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kjv() -> Bible {
        parse_json("KJV", "KJV", &gunzip(KJV_GZ)).unwrap()
    }

    #[test]
    fn references() {
        let b = kjv();
        let r = search(&b, "Jn 3:16");
        assert_eq!(r.kind, "reference");
        assert_eq!(r.title, "John 3");
        assert_eq!(r.selected, vec![16]);
        assert!(r.verses[15].text.starts_with("For God so loved"));
        assert_eq!(search(&b, "1 cor 13:4-7").selected, vec![4, 5, 6, 7]);
        assert_eq!(search(&b, "psalm 23").title, "Psalms 23");
        assert_eq!(search(&b, "Rev 22 21").selected, vec![21]);
        assert_eq!(search(&b, "1john 1:9").title, "1 John 1");
        assert_eq!(search(&b, "II Kings 2:11").title, "2 Kings 2");
        assert_eq!(search(&b, "phil 4:13").title, "Philippians 4");
    }

    #[test]
    fn keywords() {
        let b = kjv();
        let r = search(&b, "shepherd want");
        assert_eq!(r.kind, "text");
        assert!(r.verses.iter().any(|v| v.book_name == "Psalms" && v.chapter == 23 && v.verse == 1));
        assert!(!b.books[61].chapters[1][22].1.contains('['));
    }
}
