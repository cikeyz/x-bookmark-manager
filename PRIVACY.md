# Privacy Policy — X Bookmarks Manager (CK Fork)

**Last updated:** 6 September 2026

## Summary

X Bookmarks Manager is a free browser extension that runs entirely in your browser. It sends none of your data to our servers, shares nothing with third parties, and performs no advertising tracking.

## Data collected

The extension processes the following data **only on your local device**:

- Your X (Twitter) bookmarks (read from X's own API while the bookmarks page loads)
- Your bookmark archive (stored in the browser's IndexedDB; migrated automatically from the legacy `chrome.storage.local` archive)
- Your settings (fetch delay, theme preference, custom-view toggle, stored in `chrome.storage.sync`)

## Data transfer

- No data is sent to any external server
- No analytics, telemetry, or advertising network is used
- JSON export happens fully locally; the file downloads directly to your computer

## Permissions

| Permission | Purpose |
|------|------|
| `storage` | Store settings and the legacy bookmark archive |
| `unlimitedStorage` | Keep large bookmark archives past the browser quota |
| `x.com` / `twitter.com` access | Show the custom interface on the bookmarks pages and read X API responses |

## Data storage and deletion

- Fetched bookmarks are kept on your device for use across sessions
- Removing the extension or clearing browser data deletes the archive
- Bookmark data is never stored by the extension author; each session re-reads from X

## Contact

Use the Issues section of the GitHub repository for questions.
