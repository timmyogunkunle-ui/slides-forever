# Shine — worship presentation, made simple

A fast, modern alternative to EasyWorship, written in Rust (Tauri). One small `.exe`, no install.

![icon](icons/icon.png)

## What it does

| | |
|---|---|
| **Songs** | Type new songs or import `.txt` files (many at once). Blank line = new slide. `Verse 1`, `Chorus`, `Bridge`… on their own line become slide labels. `---` forces a split. |
| **Bible** | KJV and BSB (Berean Standard Bible) built in, works offline. Type `John 3:16`, `jn 3 16-18`, `1 cor 13:4-7`, `ps 23` or plain words (`love never fails`) and press **Enter** to go straight to live. Import extra Bibles (JSON or text) in Settings. |
| **Media** | Images, GIFs and videos (MP4, WebM, MOV). Use them as items, as song/scripture backgrounds, or as your logo. Videos loop and keep playing between slides. |
| **Preview + Live** | Click anything to preview it, double-click (or **Enter / GO LIVE**) to send it live. Live has its own slide strip, Black, Clear and Logo, plus video play/pause/seek. |
| **Screens** | The **Live screen** button shows every connected display laid out like Windows display settings, with real monitor names (e.g. *EPSON Projector · HDMI · 1920×1080*). Click one, then **Send live output here**. **Identify screens** flashes a number on each. Shine remembers your choice and picks the projector automatically next time. |
| **Service** | Drag songs, verses and media into the Service list, reorder by dragging. Saved automatically. |

### Keyboard

| Key | Action |
|---|---|
| Enter | Preview → Live |
| → ↓ Space PgDn / ← ↑ PgUp | Next / previous slide |
| 1–9, Home, End | Jump to slide |
| B | Black screen |
| C | Clear text (keep background) |
| L | Logo |
| Esc | Clear everything (on the output window: close output) |
| Ctrl+N | New song |

## Moving to another laptop

* Copy the `Shine` folder (or just `Shine.exe` from a GitHub build) and double-click it.
* Needs Windows 10/11 with the Microsoft Edge WebView2 runtime (already on every Windows 11 PC and almost all Windows 10 PCs).
* Your songs, media list and settings live in `%APPDATA%\com.shine.worship`. Copy that folder too to bring your library.
* **Portable mode:** make a folder called `ShineData` next to `Shine.exe` and everything is stored there instead — perfect for a USB stick.
* Media files are linked, not copied, so keep them in the same place (or re-add them).

## Bible translations

KJV and BSB are public domain and are bundled. **NIV is copyrighted by Biblica** and cannot be shipped in free software without a licence. The BSB is a modern, accurate translation that reads very similarly. If you obtain a licensed copy in JSON or one-verse-per-line text (`John 3:16 For God so loved…`), use **Settings → Import another Bible**.

## Building

```powershell
.\build.ps1
```

Or push to GitHub: the included workflow (`.github/workflows/build.yml`) builds a single self-contained `Shine.exe` on every push. Tag a version (`git tag v1.0.0 && git push --tags`) to publish it as a GitHub Release download.

Data sources: Bible texts from [scrollmapper/bible_databases](https://github.com/scrollmapper/bible_databases) (public domain).
