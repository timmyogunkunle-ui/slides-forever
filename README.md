# Slides Forever

![Slides Forever](ui/logo.png)

Fast, friendly worship presentation software: a modern alternative to EasyWorship, written in Rust (Tauri). One small `.exe`, no installer.

## Features

| | |
|---|---|
| **Songs** | Type songs in, import `.txt` files, or **import your whole EasyWorship library**. Blank line = new slide; `Verse 1`, `Chorus`, `Bridge`… label slides; `---` splits a slide. |
| **Bible** | KJV and BSB built in (offline). Type `John 3:16`, `jn 3 16-18`, `1 cor 13:4-7`, `ps 23` or plain words and press **Enter** to go straight to live. Import more Bibles in Settings. |
| **Media** | Images, GIFs and videos (MP4, WebM, MOV) as items or backgrounds. Background videos keep playing between slides. |
| **Slide groups** | Drop a **PDF**, a **PowerPoint** (`.ppt/.pptx/.pps/.ppsx`) or several **pictures** into the window and they become a slide group. Advance by hand or **auto-play** every N seconds, with optional looping. PowerPoint files are converted using the copy of PowerPoint installed on the PC; PDFs use Windows' built-in PDF engine. |
| **Preview + Live** | Click to preview, double-click / **Enter** / **GO LIVE** to send live. Black, Clear and **Standby** buttons, video play/pause/seek. |
| **Transitions** | Fade, Slide, Zoom, Wipe, Blur or Cut, with adjustable speed (quick picker on the Live panel). |
| **Standby screen** | Your logo by default. Set any picture/video/GIF, a message, or right-click any slide → *Use this slide as the standby screen*. Optionally shown automatically whenever nothing is live. |
| **Scrolling message** | Type a message on the Live panel and press **Scroll** (or `T`) to run a ticker along the bottom or top of the screen, over whatever is live. |
| **Screens** | The **Live screen** button shows every connected display laid out like Windows display settings, with real monitor names (e.g. *EPSON Projector · HDMI · 1920×1080*), plus **Identify screens**. |
| **Colours** | Warm Sand (default), Royal Blue, Forest, Plum or Midnight (dark), under Settings → App colours. |

### Keyboard

| Key | Action |
|---|---|
| Enter | Preview → Live |
| → ↓ Space PgDn / ← ↑ PgUp | Next / previous slide |
| 1–9, Home, End | Jump to slide |
| B | Black screen |
| C | Clear text (keep background) |
| S | Standby screen |
| T | Scrolling message on/off |
| Esc | Clear everything (on the output window: close it) |
| Ctrl+N | New song |

## Where your songs are saved

On first launch Slides Forever asks where to keep your **library**. The default is `Documents\Slides Forever`; you can pick any folder (USB stick, OneDrive/Dropbox, a shared drive) and change it later in **Settings → Your library folder**.

```
<your library folder>\
  songs.json       all your songs
  media.json       your list of pictures/videos (files stay where they are)
  groups.json      slide groups
  slides\<id>\     the pages of each slide group (PNG)
  imports\         files you dragged into the app
  bibles\          extra Bibles you imported
  settings.json, schedule.json
```

If you pick a folder that already contains a library, Slides Forever opens it; otherwise your current library is copied there. Back up by copying the folder.

**Portable mode:** create a folder called `SlidesForeverData` next to `SlidesForever.exe` and everything is stored there instead.

## Importing from EasyWorship

EasyWorship 6, 7 and 8 keep songs in SQLite databases here:

```
C:\Users\Public\Documents\Softouch\Easyworship\<Profile>\v6.1\Databases\Data\Songs.db
C:\Users\Public\Documents\Softouch\Easyworship\<Profile>\v6.1\Databases\Data\SongWords.db   (lyrics, as RTF)
```

(`<Profile>` is usually `Default`; the exact folder is listed in `C:\ProgramData\Softouch\Easyworship.v8\Profiles\*.ewp`.)

In Slides Forever: **Songs → From EasyWorship**. Libraries on the same PC are found automatically. For the church computer, copy its whole `Data` folder to a USB stick, then use **Browse for Songs.db**. EasyWorship's files are only ever read (from a temporary copy), never changed.

## Moving to another laptop

* Copy `SlidesForever.exe` (from a GitHub build) or the `SlidesForever` folder, and double-click.
* Needs Windows 10/11 with the Microsoft Edge WebView2 runtime (on every Windows 11 PC and nearly all Windows 10 PCs).
* Bring your library folder (or point the new laptop at a shared one).

## Bible translations

KJV and BSB are public domain and bundled. **NIV is copyrighted by Biblica** and can't be shipped without a licence; BSB reads very similarly. Licensed Bibles in JSON or one-verse-per-line text can be added via **Settings → Import another Bible**.

## Building

```powershell
.\build.ps1
```

Or push to GitHub: `.github/workflows/build.yml` builds a single self-contained `SlidesForever.exe` on every push; tag a version (`git tag v1.0.0; git push --tags`) to publish it as a Release download.

Bible texts: [scrollmapper/bible_databases](https://github.com/scrollmapper/bible_databases) (public domain).
