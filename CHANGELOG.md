# Changelog

## 0.1.0 — 2026-11-15

Initial release.

- Full CyberChef v11.5.0 UI in a VS Code editor panel. Works completely offline from a loopback-only local server.
- **Send Selection to Input** (editor context menu) and **Send File to Input** (explorer context menu, binary-safe).
- **Insert Output into Editor**, **Open Output in New Editor** and **Copy Output to Clipboard** (editor title buttons on the CyberChef panel).
- **Load Recipe…** accepts Chef format, JSON or a full CyberChef URL with `#recipe=`.
- Theme follows VS Code (light → Classic, dark → Dark), or choose any CyberChef theme.
- CyberChef's "Save output / recipe to file" opens the native VS Code save dialog.
- CyberChef `prompt()` dialogs (e.g. "go to tab") are shown as VS Code input boxes.
- External links open in the system browser.
- The panel restores its recipe and input after a window reload.
