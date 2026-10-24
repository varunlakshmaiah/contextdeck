# Changelog

All notable changes to ContextDeck. Versions follow the plugin manifest (`0.5.1` = `0.5.1.0`).

## [Unreleased]

### Added
- Standard repository files: MIT license, contributing guide, security policy, code of conduct, issue and pull request templates, CI and Dependabot.

### Changed
- Bundled profiles build reproducibly: rebuilding gives byte-identical files.

## [0.5.1] - 2026-10-24

First public release.

### Added
- **Profiles that install with the plugin.** The Stream Deck +, MK.2, Mini and XL each get a ready-made ContextDeck profile with every key and dial filled in. Stream Deck switches to it when the plugin is installed, so nothing has to be dragged in by hand.
- **Swipe to change pages.** The bundled profile has five identical Stream Deck pages. Swiping the touch strip turns ContextDeck's page and then returns to the middle page, so you can keep swiping either way. `settings.swipeRecenter: false` turns off the return.

## [0.5.0] - 2026-10-24

### Added
- **macOS, Windows and Linux.** The core talks to one adapter per OS:
  - macOS: AppleScript and Accessibility.
  - Windows: a PowerShell helper using Win32, UI Automation, Credential Manager and Core Audio.
  - Linux: X11, Hyprland, Sway, KDE or GNOME for the app in front; xdotool or wtype for keys; libsecret for secrets.
  - Linux runs under [OpenDeck](https://github.com/nekename/OpenDeck), which reads the extra `manifest.linux.json`.
- **Every Stream Deck.** Mini, MK.2, XL, Neo, Pedal, +, Studio, + XL and Mobile, several at once, each with its own page. Layouts written for the + re-flow onto other decks. Bigger decks also show each layout's extra pages on page 1. Decks without dials get a page key. `settings.deviceZones` overrides the split per deck.
- **Cross-platform layouts.**
  - `match.bundleId` takes macOS bundle ids, Windows exe names and Linux WM_CLASS names together.
  - `cmd` becomes Ctrl on Windows and Linux (`settings.cmdKey`), and `mod` always means Cmd or Ctrl.
  - Any action can carry `"on": { "win": …, "linux": … }` replacements; info keys take `"on"` too.
  - `match.os` limits a layout to one system.
  - A new `script` action runs AppleScript, JXA, PowerShell or sh.
- **The ContextDeck app.** A local web page at `127.0.0.1:47811/ui` with these sections:
  - Live deck view: click a key to press it.
  - Layout editor.
  - Keys and secrets.
  - AI providers.
  - Stream Deck plugins.
  - Browser.
  - Settings.
  - Logs.

  Open it by holding the AI key and choosing **App**, or with `deck ui`.
- **Browser extension** for Chromium browsers and Firefox. It reports the exact URL and title of the tab in front, and Linux needs it for site layouts. You pair it with the deck by pressing **Allow** on a key. Private and incognito tabs aren't shared unless you turn that on.
- **Official plugins' actions.** A key can trigger actions from your other Stream Deck plugins through Elgato's MCP server, with `{ "type": "elgato", "tool": "…" }`. This needs Stream Deck 7.4 or later and isn't available on Linux.
- **CLI on every OS.** The `deck` CLI is now a Node script that runs on the plugin's own Node (`deck.cmd` on Windows). New commands: `devices`, `ui`, `elgato`.
- **Secrets on every OS:**
  - Stored in the Keychain, Credential Manager or libsecret.
  - New API routes: `POST /secrets` and `DELETE /secrets/:name`.
- **MCP tools:** `deck_devices`, `deck_elgato_tools`, `deck_elgato_run`.
- **API routes:**
  - `/pair`, `/context/browser`, `/render`, `/devices`, `/logs`, `/browser`.
  - `GET|PUT /settings`, `GET /layouts`, `GET /layouts/:id`, `/ui`, `/elgato/*`.

### Changed
- The deck menu's **Reload** key is now **App**. Reload moved into the app.
- `deck secret set` stores secrets through the running plugin instead of calling `security` directly.
- Layouts may have up to 64 keys and 6 dials.

### Security
- The local API only answers requests addressed to `127.0.0.1` or `localhost`, which blocks DNS-rebinding attacks.
- Requests from web pages are refused. Only the extension and the app's own page are allowed.
- The app's token travels in the URL fragment, which isn't sent over the network, and is removed from the address bar on load.

## [0.4.0] - 2026-10-23

Before this public repository existed.

- Three context levels (system, app, sub) and pages.
- ✨ Set up with web research.
- Read-only info keys.
- Per-app secrets as `{{secret.NAME}}`, sent only to the hosts each one declares.
- Any LLM provider.
- Local API, CLI and MCP bridge.

[Unreleased]: https://github.com/varunlakshmaiah/contextdeck/compare/v0.5.1...HEAD
[0.5.1]: https://github.com/varunlakshmaiah/contextdeck/releases/tag/v0.5.1
[0.5.0]: https://github.com/varunlakshmaiah/contextdeck/commit/1b63624
[0.4.0]: https://github.com/varunlakshmaiah/contextdeck/commit/b58cda9
