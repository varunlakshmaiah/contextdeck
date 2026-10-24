# Contributing to ContextDeck

Thanks for helping. Bug reports from **Windows** and **Linux (OpenDeck)** are especially valuable right now, because those platforms haven't been tested on real hardware yet.

## Reporting bugs

Open an [issue](https://github.com/varunlakshmaiah/contextdeck/issues/new/choose) and include:

- your OS and version, your host app (Stream Deck or OpenDeck) and its version, and your Stream Deck model;
- what you expected and what happened;
- the relevant part of `~/.contextdeck/debug.json`, or the app's **Logs** section.

Before you post a log, check it doesn't contain anything private. Logs don't include secret values, but they can include app names, URLs and window titles.

## Suggesting layouts

New built-in layouts for popular apps and sites are welcome. Follow the naming convention in the README (`app.<appId>`, `site.<host>` …) and put each layout in its own file under `com.var.contextdeck.sdPlugin/defaults/layouts/`. Where possible, include Windows and Linux app ids and `"on"` replacements for shortcuts that differ.

## Development

You need Node.js 22 or later, plus `zip` and `unzip`.

```bash
npm install
npm test            # unit tests
npm run build       # plugin, CLI, MCP bridge, profiles, browser extension
npm run validate    # Elgato's manifest checks
npm run link        # symlink into the Stream Deck app for live testing
npm run watch       # rebuild and restart the plugin on save
```

`npm run test:e2e` runs the API, CLI, MCP bridge, browser extension and app against real Chromium. It needs Playwright and a Chromium install; set `PLAYWRIGHT_PATH` if Playwright isn't in `node_modules`.

### Where things live

| Path | What's there |
|---|---|
| `src/engine.ts` | context detection, pages, devices, actions, ✨ Set up |
| `src/resolve.ts` | picking layouts per level and laying them out on each deck |
| `src/platform/` | one adapter per OS (`mac.ts`, `win.ts`, `linux.ts`) behind `types.ts` |
| `src/hosts/elgato/` | the Stream Deck / OpenDeck plugin entry point and actions |
| `src/api.ts`, `src/cli.ts`, `mcp/server.ts` | local API, `deck` CLI, MCP bridge |
| `com.var.contextdeck.sdPlugin/ui/` | the ContextDeck app |
| `extension/` | the browser extension source |
| `scripts/` | icon, profile and extension builders |

### Pull requests

- Keep each change focused, and add or update tests in `test/`.
- Run `npm run typecheck`, `npm test` and `npm run validate` before opening the PR; CI runs the same checks.
- Add a line to the `Unreleased` section of `CHANGELOG.md`; create the section if it isn't there yet.
- Never commit real API keys, tokens or personal data. Secrets belong in the OS credential store, referenced as `{{secret.NAME}}`.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
