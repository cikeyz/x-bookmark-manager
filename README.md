<div align="center">

<img src="assets/banner.png" alt="X Bookmarks Manager" width="100%" />

# X Bookmarks Manager

**A free browser extension that turns your X (Twitter) bookmarks into a fast masonry view.**

Search, filter by date and author, export to JSON, and auto-load thousands of pages - all in one clean interface that matches X native dark mode.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Manifest V3](https://img.shields.io/badge/manifest-V3-1d9bf0.svg)](manifest.json) [![Vanilla JS](https://img.shields.io/badge/js-vanilla-yellow.svg)](content/)

> Note
>
> This is a maintained fork of [`sarisen/x-bookmark-manager`](https://github.com/sarisen/x-bookmark-manager).
> It preserves the capture-and-export core while translating the UI to English, supporting the X History page,
> adding dark mode, and hardening bulk loading for 10k+ bookmark archives.

[Why this fork](#why-this-fork) | [Installation](#️-installation) | [Features](#-features) | [Privacy](#-privacy) | [Development](#development)

</div>

---

## Why this fork

The original project is a focused bookmarks viewer. This fork keeps that scope and improves the daily-use path around it:

- English UI throughout (extension strings, settings page, manifest description)
- X History page support (`x.com/i/history` alongside `x.com/i/bookmarks`)
- Native-matching dark mode (X lights-out palette, auto-detected, toggle persisted)
- Header dropdown menus for Export and Load All (bottom pill removed)
- Tweet text clamping with fade mask plus Read more / Show less
- View filters: date tabs (All / 7D / 30D / Custom), newest-first or oldest-first sort
- Custom view toggle as a header button plus a floating button that persists in the native pane
- Bulk-load hardening: grid renders first 100 only with Show more, per-page renders gated during Load All, event delegation, archive saves throttled
- IndexedDB archive storage (auto-migrates the old `chrome.storage.local` archive, survives 10k+ archives past the ~10MB storage cap)
- Backoff retry on rate-limited page fetches (30s/60s/120s/180s/180s, then stops)
- Extension logo links to `x.com/home`; Helium `openOptionsPage` crash fixed

No data leaves the browser.

## ⬇️ Installation

> The extension is not on the Chrome Web Store; install it unpacked with the steps below.

1. **Clone:** `git clone https://github.com/cikeyz/x-bookmark-manager.git`
2. Open **`chrome://extensions`** in your Chromium browser (Chrome, Helium, Edge, Brave).
3. Enable **Developer mode** from the top right.
4. Click **Load unpacked** and select the cloned **`x-bookmark-manager`** folder.
5. Open [x.com/i/bookmarks](https://x.com/i/bookmarks) (or [x.com/i/history](https://x.com/i/history) and stay on the Bookmarks tab) - the new interface is ready!

## ✨ Features

- 🧱 **Masonry grid** - bookmarks grouped into cards by month
- 🔍 **Search** and an **Authors** tab for quick filtering
- 🗓️ **Date tabs** - All, last 7 days, last 30 days, or a custom range; newest or oldest first
- ⏬ **Load All** - header menu fetches every page with a configurable delay (default 3s), live progress line, Stop keeps what is loaded
- 📄 **Show more** - grid renders the first 100 cards, append 100 per click
- 📖 **Read more** - long posts clamp to 8 lines with a soft fade instead of a wall of text
- 🗑️ **Remove bookmark** - directly from the card
- 📤 **Export to JSON** - header menu: last 7 or 30 days, custom range, or full archive by tweet date
- 💾 **Local archive** - fetched bookmarks survive browser restarts (IndexedDB)
- 🌙 **Dark mode** - matches X lights-out, auto-detected, toggle in the header
- ⚙️ **Settings** - wait time between pages (1-60s)

## ⚙️ Settings

Click the **gear icon** in the header, or **right-click the extension icon → Options**.

## JSON output

Each record includes `bookmarkedAt` and `lastSeenAt` alongside the tweet data.
`bookmarkedAt` is the first time the extension observed the bookmark and can drive weekly or monthly processing.

## 🔒 Privacy

All data is processed **only in your browser**; nothing is sent to any external server and no analytics/telemetry is used. Details: [PRIVACY.md](PRIVACY.md)

## 🧩 Project structure

```
├── manifest.json
├── content/
│   ├── content.js    # UI
│   ├── inject.js     # X API capture
│   ├── parser.js     # GraphQL response parsing
│   ├── archive.js    # IndexedDB local archive
│   └── styles.css
├── options/          # Settings page
├── icons/            # Extension icons
├── assets/           # Promotional images
└── test/             # node:test suite (archive round-trips)
```

## Development

```bash
node --check content/archive.js && node --check content/content.js && node --check content/inject.js && node --check content/parser.js
node --test test/archive.test.js
```

Reload the extension card on `chrome://extensions` and hard-refresh the X tab after changing files.

## Upstream and license

- Maintained fork: [`cikeyz/x-bookmark-manager`](https://github.com/cikeyz/x-bookmark-manager)
- Original project: [`sarisen/x-bookmark-manager`](https://github.com/sarisen/x-bookmark-manager)

Released under the [MIT License](LICENSE).
