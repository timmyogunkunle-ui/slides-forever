//! Slide groups: turn PDFs, PowerPoint decks and images into numbered PNG/image pages
//! stored in <library>/slides/<group id>/.

use std::{
    fs,
    path::{Path, PathBuf},
};

pub const PDF_EXT: &[&str] = &["pdf"];
pub const PPT_EXT: &[&str] = &["ppt", "pptx", "pps", "ppsx", "pptm", "odp"];

fn ext(p: &Path) -> String {
    p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

/// Build one slide group from any mix of PDFs, decks and images. Returns the page files in order.
pub fn build_group(sources: &[PathBuf], out_dir: &Path) -> Result<Vec<PathBuf>, String> {
    fs::create_dir_all(out_dir).map_err(|e| e.to_string())?;
    let mut pages = Vec::new();
    for src in sources {
        let e = ext(src);
        let start = pages.len();
        if PDF_EXT.contains(&e.as_str()) {
            pages.extend(render_pdf(src, out_dir, start)?);
        } else if PPT_EXT.contains(&e.as_str()) {
            pages.extend(export_powerpoint(src, out_dir, start)?);
        } else if crate::library::media_kind(src).is_some() {
            let dest = out_dir.join(format!("{:03}.{}", start + 1, e));
            fs::copy(src, &dest).map_err(|err| format!("{}: {err}", src.display()))?;
            pages.push(dest);
        } else {
            return Err(format!("Can't make slides from {}", src.display()));
        }
    }
    if pages.is_empty() {
        return Err("No pages were found in those files.".into());
    }
    Ok(pages)
}

#[cfg(windows)]
fn render_pdf(src: &Path, out_dir: &Path, offset: usize) -> Result<Vec<PathBuf>, String> {
    use windows::{
        core::HSTRING,
        Data::Pdf::{PdfDocument, PdfPageRenderOptions},
        Storage::{
            StorageFile,
            Streams::{DataReader, InMemoryRandomAccessStream},
        },
        Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED},
    };
    let src = fs::canonicalize(src).map_err(|e| e.to_string())?;
    let path = src.to_string_lossy().trim_start_matches(r"\\?\").to_string();
    let out_dir = out_dir.to_path_buf();
    // WinRT needs an initialised apartment; do the work on a dedicated thread.
    std::thread::spawn(move || -> windows::core::Result<Vec<PathBuf>> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path.as_str()))?.join()?;
        let doc = PdfDocument::LoadFromFileAsync(&file)?.join()?;
        let mut pages = Vec::new();
        for i in 0..doc.PageCount()? {
            let page = doc.GetPage(i)?;
            let size = page.Size()?;
            let opts = PdfPageRenderOptions::new()?;
            let w = 1920u32;
            let h = ((size.Height / size.Width.max(1.0)) * w as f32).round().max(1.0) as u32;
            opts.SetDestinationWidth(w)?;
            opts.SetDestinationHeight(h)?;
            let stream = InMemoryRandomAccessStream::new()?;
            page.RenderWithOptionsToStreamAsync(&stream, &opts)?.join()?;
            let len = stream.Size()? as u32;
            let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0)?)?;
            reader.LoadAsync(len)?.join()?;
            let mut buf = vec![0u8; len as usize];
            reader.ReadBytes(&mut buf)?;
            let dest = out_dir.join(format!("{:03}.png", offset + pages.len() + 1));
            fs::write(&dest, &buf).map_err(|e| windows::core::Error::new(windows::core::HRESULT(-1), e.to_string()))?;
            pages.push(dest);
        }
        Ok(pages)
    })
    .join()
    .map_err(|_| "PDF renderer crashed".to_string())?
    .map_err(|e| format!("Could not read the PDF: {}", e.message()))
}

#[cfg(not(windows))]
fn render_pdf(_: &Path, _: &Path, _: usize) -> Result<Vec<PathBuf>, String> {
    Err("PDF import is only available on Windows".into())
}

/// Export every slide to PNG using the installed copy of PowerPoint.
fn export_powerpoint(src: &Path, out_dir: &Path, offset: usize) -> Result<Vec<PathBuf>, String> {
    let tmp = out_dir.join(format!("_export{offset}"));
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    // Paths travel through environment variables so no quoting can break the script.
    let script = r#"
$ErrorActionPreference = 'Stop'
try { $app = New-Object -ComObject PowerPoint.Application } catch { Write-Error 'NOPOWERPOINT'; exit 3 }
$p = $app.Presentations.Open($env:SF_SRC, $true, $false, $false)
$w = 1920
$h = [int][Math]::Round($w * $p.PageSetup.SlideHeight / $p.PageSetup.SlideWidth)
$i = 0
foreach ($s in $p.Slides) { $i++; $s.Export((Join-Path $env:SF_OUT ('{0:D3}.png' -f $i)), 'PNG', $w, $h) }
$p.Close()
if ($app.Presentations.Count -eq 0) { $app.Quit() }
"#;
    let mut cmd = std::process::Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script])
        .env("SF_SRC", src)
        .env("SF_OUT", &tmp);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        let _ = fs::remove_dir_all(&tmp);
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(if out.status.code() == Some(3) || err.contains("NOPOWERPOINT") {
            "PowerPoint isn't installed on this PC. Open the file in PowerPoint (or Google Slides) and save it as a PDF, then drop the PDF in instead.".into()
        } else {
            format!("PowerPoint couldn't export this file: {}", err.lines().next().unwrap_or("unknown error"))
        });
    }
    let mut files: Vec<PathBuf> = fs::read_dir(&tmp).map_err(|e| e.to_string())?.flatten().map(|e| e.path()).collect();
    files.sort();
    let mut pages = Vec::new();
    for f in files {
        let dest = out_dir.join(format!("{:03}.png", offset + pages.len() + 1));
        fs::rename(&f, &dest).map_err(|e| e.to_string())?;
        pages.push(dest);
    }
    let _ = fs::remove_dir_all(&tmp);
    Ok(pages)
}

#[cfg(test)]
mod local {
    /// Converts real files: `SF_TEST_PDF=... SF_TEST_PPT=... cargo test -- --ignored convert_real_files`
    #[test]
    #[ignore]
    fn convert_real_files() {
        for var in ["SF_TEST_PDF", "SF_TEST_PPT"] {
            let Ok(src) = std::env::var(var) else { continue };
            let out = std::env::temp_dir().join(format!("sf-slides-test-{var}"));
            let _ = std::fs::remove_dir_all(&out);
            let pages = super::build_group(&[std::path::PathBuf::from(&src)], &out).unwrap();
            println!("{var}: {} page(s)", pages.len());
            for p in &pages {
                let bytes = std::fs::read(p).unwrap();
                assert_eq!(&bytes[1..4], b"PNG", "{} is not a PNG", p.display());
                println!("  {} ({} bytes)", p.display(), bytes.len());
            }
            assert!(!pages.is_empty());
        }
    }
}
