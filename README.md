# ContextDeck

A Stream Deck plugin that redraws its keys and dials from three context levels:

- **system:** the AI key, volume, and OS controls;
- **app:** whatever app is in front, such as a browser's tab controls;
- **sub:** what's inside that app, such as the website or YouTube video you're on.

It can set itself up for any app or website. ✨ Set up reads the app's real menus, can research its current docs online, and has your chosen AI model build a layout. That layout can include **live info keys** (usage, counts, battery…) and **API actions**, with your keys kept in your system's credential store.

| | macOS | Windows | Linux |
|---|---|---|---|
| Host app | Stream Deck 7.1+ | Stream Deck 7.1+ | [OpenDeck](https://github.com/nekename/OpenDeck), native install, with Node.js |
| App in front | ✓ | ✓ (Store apps too) | X11, Hyprland, Sway, KDE (kdotool), GNOME ("Window Calls" extension) |
| Website in front | ✓ (Chromium browsers and Safari), or the extension | the extension (best), or the address bar | the extension |
| Keys, typing | ✓ | ✓ | xdotool (X11) or wtype (Wayland) |
| Menus for ✨ Set up | ✓ | classic menu bars | none (research and model knowledge) |
| Secrets stored in | Keychain | Credential Manager | libsecret (`secret-tool`) |
| Official plugins' actions | ✓ (Stream Deck 7.4+) | ✓ (Stream Deck 7.4+) | not available |

It works on every Stream Deck (Mini, MK.2, XL, Neo, Pedal, +, Studio, + XL and Mobile), including several at once, each with its own page.

## Install

1. Double-click `com.var.contextdeck.streamDeckPlugin`. On Linux, use OpenDeck → Plugins → install from file.
2. Accept the **ContextDeck** profile Stream Deck offers to install (bundled for the +, MK.2, Mini and XL; it's switched to automatically). On other decks, make a profile with **Context Key** on every key and **Context Dial** on every dial.
3. Let it see apps and press keys:
   - **macOS:** System Settings → Privacy & Security → **Accessibility** → turn on **Stream Deck**. Allow it to control your browser the first time it asks.
   - **Windows:** nothing to do.
   - **Linux:** install `xdotool` and `xprop` (X11) or `wtype` (Wayland), plus `wl-clipboard` or `xclip`, `libnotify`, `zenity` and `libsecret-tools`.
4. Add an AI provider key with `~/.contextdeck/deck secret set openrouter` (on Windows, `%USERPROFILE%\.contextdeck\deck.cmd secret set openrouter`), or use the app.
5. Optional: install the **browser extension** (see below) for exact site detection.

To open the ContextDeck app, hold the AI key and choose **App**.

On first run the plugin creates `~/.contextdeck/`:

```
config.json                 settings: AI providers, zones, research, global secrets
layouts/
  system/system.json        level "system": AI key, volume, macOS controls (+ system page)
  apps/app.<bundleId>.json  level "app": one per app (or app.<group> for families, e.g. app.browsers)
  sites/site.<host>.json    level "sub": one per website
  subs/sub.<bundleId>.<name>.json   level "sub": windows/documents inside a native app (via a probe)
  takeovers/takeover.<name>.json    flag-driven layouts that replace app+sub (e.g. recording)
menus/<bundleId>.txt        last menu scan of each app (real items + shortcuts)
research/<id>@<version>.json  cached research digests per app version
extension/{chrome,firefox}   the browser extension, ready for Load unpacked
setup-state.json · prefs.json · debug.json · token · deck (CLI; deck.cmd on Windows)
```

Save any file and the deck reloads instantly. An emptied file means that layout is disabled. Older `layouts.json` and flat `layouts/*.json` files still load.

## Naming convention

| Thing | Convention | Examples |
|---|---|---|
| App id | macOS bundle id · Windows exe name · Linux WM_CLASS (lowercase, except bundle ids) | `com.google.Chrome`, `chrome.exe`, `google-chrome` |
| Layout id | `system` · `app.<appId>` · `app.<group>` · `site.<host>` · `sub.<appId>.<name>` · `takeover.<name>` | `app.com.figma.Desktop`, `app.browsers`, `site.studio.youtube.com` |
| File | `layouts/<level folder>/<id>.json` | `layouts/sites/site.linear.app.json` |
| Secret | UPPER_SNAKE `<SERVICE>_<KIND>`, where KIND is `API_KEY`, `TOKEN`, `URL` or `SECRET` | `GITHUB_TOKEN`, `YOUTUBE_API_KEY`, `HOME_ASSISTANT_URL` |
| Secret use | `{{secret.NAME}}` in an http action or info source | `"Authorization": "Bearer {{secret.GITHUB_TOKEN}}"` |
| State key | lowercase dotted `<namespace>.<name>` | `agent.status`, `render.progress` |
| Flag | lowercase kebab | `recording`, `meeting` |
| Page id | `smart` · `sub` · `app` · `system` · `<layoutId>:<pageName>` | `app.browsers:Tabs` |
| AI provider id | lowercase preset or your own | `openrouter`, `ollama`, `home-gpu` |

## Levels, zones and pages

**Page 1 ("Smart")** mixes the levels by zone. You can change the zones in `config.json → settings.zones`:

```
 ┌──────┬──────┬──────┬──────┐
 │ sub  │ sub  │ sub  │ sub  │   e.g. YouTube: Play/Pause · Back 10s · Fwd 10s · Fullscreen
 ├──────┼──────┼──────┼──────┤
 │ app  │ app  │ app  │ sys  │   e.g. Browser: New Tab · Close Tab · Duplicate · AI key
 └──────┴──────┴──────┴──────┘
  dials:  sub    sub    app    sys    e.g. Seek · Speed · Tabs · Volume
```

Each layout lists its keys **most important first**. When a level has nothing, its zone goes to the other level, so a plain Chrome tab shows 7 browser keys. Spare slots take the next keys in line. Each key's top stripe has its layout's color, so you can see which level it belongs to.

**More pages:** each level in full, any `"pages": [{ "name", "keys", "dials" }]` a layout adds, and the system page. For example, YouTube gives you Smart → YouTube → Video → Browser → Tabs → System.

**Changing pages:**
- Tap the far left or far right edge of the touch strip.
- Long-touch the strip to go to the next page.
- Use **Next page** in the deck menu, or `deck page next|sub|app|system`.

The deck remembers your page per context, so going back to YouTube returns to the page you left.

**Sub-contexts in native apps.** Give the app layout a probe and match on its output:

```jsonc
// layouts/apps/app.com.apple.mail.json
"probe": { "type": "windowTitle" }            // or { "type": "applescript", "script": "tell application \"Mail\" to get name of …" }
// layouts/subs/sub.com.apple.mail.compose.json
{ "id": "sub.com.apple.mail.compose", "level": "sub", "match": { "bundleId": "com.apple.mail", "sub": "*Re:*" }, "keys": [ … ] }
```

## Pages and swiping

Swipe the touch strip (or tap its outer edges) to change ContextDeck's page; the `1/3` on the last dial shows where you are. Stream Deck keeps swipes for itself, so the bundled profile has five identical Stream Deck pages: when one appears, ContextDeck knows which way you swiped, turns its own page, and moves back to the middle page so you can keep swiping either way (`settings.swipeRecenter: false` turns the jump back off). Decks without a touch strip use the page key.

## Every Stream Deck

Layouts are written for the Stream Deck + (8 keys, 4 dials). Other decks get the same layouts re-flowed in reading order: site keys first, then app keys, then the system row at the end.

| Deck | What changes |
|---|---|
| XL, Studio, + XL, Mobile | Page 1 also shows each layout's extra pages, so a 32-key deck shows about four + pages at once. The system row gets up to 8 keys. |
| MK.2, Mini, Neo, Pedal | Fewer keys per page. With no dials, the **last key turns pages**: tap for next, hold for previous. |
| Studio, Galleon, + XL | 2 or 6 dials, split the same way. The system level keeps the last dial. |

Several decks work at once, each with its own page. To override a deck's zones, use `settings.deviceZones` keyed by `xl`, `mk2`, `mini`, `neo`, `studio`, `plusxl`, `mobile` or `<cols>x<rows>`.

## Windows and Linux

The built-in layouts work on all three systems:

- **One app, three ids:** `match.bundleId` lists `com.google.Chrome`, `chrome.exe` and `google-chrome*` together.
- **Shortcuts translate:** `cmd` becomes Ctrl on Windows and Linux. Set `settings.cmdKey` to `"win"` to make it the Windows/Super key instead. `mod` always means Cmd on a Mac and Ctrl elsewhere.
- **Per-OS actions:** where a shortcut differs, the action carries replacements:

  ```jsonc
  { "type": "keys", "keys": "cmd+[", "on": { "win": { "type": "keys", "keys": "alt+left" }, "linux": { "type": "keys", "keys": "alt+left" } } }
  ```

  Info keys take the same `"on"`. For example, the battery key reads `pmset` on a Mac, `Win32_Battery` on Windows and `/sys/class/power_supply` on Linux.
- **OS-only layouts:** `"match": { "os": "mac" }`. The Morning and Wind-down layouts are Mac-only.
- **Scripts:** `{ "type": "script", "script": "…", "lang": "applescript" | "jxa" | "powershell" | "sh" }`.

On Linux, install OpenDeck as a native package rather than the Flatpak, so the plugin can reach `xdotool`, `xprop` and the other tools.

## The ContextDeck app

The app is a local web page at `http://127.0.0.1:47811/ui`. Open it by holding the AI key and choosing **App**, or run `deck ui`.

| Section | What it does |
|---|---|
| Deck | Live view of each deck. Click a key to press it, Shift-click to hold it. Change page and run ✨ Set up. |
| Layouts | Every layout, grouped by level. Edit the JSON and save it to its file, or create and delete layouts. |
| Keys & secrets | Which secrets are stored or missing, where each is used and where it may be sent. Add, replace or remove them. |
| AI providers | Test and switch providers, and store their keys. |
| Stream Deck plugins | Actions from official plugins that you can bind to keys (see below). |
| Browser | Extension status and install steps. |
| Settings | AI roles, what happens with new apps, research, `cmdKey` and accent colour, or the raw JSON. |
| Logs | What the plugin is doing. |

It only answers on 127.0.0.1. The token travels in the link's `#fragment`, which is never sent over the network, and is removed from the address bar when the page loads.

## Browser extension

The extension tells the deck the exact URL and title of the tab in front. Linux needs it for site layouts. On macOS and Windows it's faster and works with every browser.

1. **Chrome, Edge, Brave, Arc, Vivaldi or Opera:** open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and pick `~/.contextdeck/extension/chrome`.
   **Firefox:** open `about:debugging`, choose **Load Temporary Add-on**, and pick `~/.contextdeck/extension/firefox/manifest.json`.
2. Press **Connect** on the page that opens, then press **Allow** on your Stream Deck.

The extension only talks to 127.0.0.1. Private and incognito tabs aren't shared unless you turn that on. Web pages can't reach the API, because requests from any origin other than the extension or the app are refused.

## Official plugins (Elgato MCP)

A key can trigger any action from your other Stream Deck plugins, such as OBS, Hue or Spotify:

1. Use Stream Deck 7.4 or later, with Node.js installed.
2. Go to **Preferences → General** and turn on **Enable MCP Deck**.
3. Put the actions you want on the **MCP Actions** profile.
4. Bind one to a key:

```json
{ "label": "Record", "icon": "circle-dot", "action": { "type": "elgato", "tool": "obs__start_recording" } }
```

The app's **Stream Deck plugins** section lists the available tools and copies the action for you. You can also run `deck elgato` to list them and `deck elgato <tool> key=value` to run one. ContextDeck starts `npx -y @elgato/mcp-server@latest` the first time it's needed; set `settings.elgato.command` to use your own install. This isn't available on Linux.

## ✨ Set up (any app or site)

When an app or site has no layout of its own, key 7 shows **✨ Set up**. For a website, this only happens under the generic Browser layout. Pressing it runs these steps:

1. **Platform:** collects the macOS version, chip, keyboard layout, locale and the app's exact version.
2. **Menus** (native apps): reads the real menu bar with every shortcut. These items count as *verified*.
3. **Research** (optional): searches the web for this app version's shortcuts, status APIs and info sources. It reads the top official pages and condenses them into a digest, cached in `research/`. Items found here count as *documented*.
4. **Design:** your `setupLlm` designs keys, dials, a **More** page, 1–2 **info keys** and API actions with `{{secret.NAME}}` placeholders.
5. **Validate:**
   - menu paths that don't exist are dropped, and every chord is checked;
   - shortcuts known only from the model's memory are tagged *knowledge*, or dropped when `research.allowKnowledge` is false;
   - info sources must be read-only, and each is test-run once (failures are dropped);
   - every secret must be declared together with its API hosts.
6. **Save:** writes `layouts/apps/app.<bundleId>.json` or `layouts/sites/site.<host>.json` and switches to it.

Every generated key records `meta.confidence` (`verified`, `documented` or `knowledge`) and `meta.source`, the URL it came from.

**App updates.** When an app updates, its key 7 shows **Update**. Pressing it re-researches for the new version and revises the layout, keeping the keys that still work.

**Research settings** live in `config.json → settings.research`:

| `provider` | Needs |
|---|---|
| `none` (default) | nothing; uses menus and model knowledge only |
| `brave` | `BRAVE_SEARCH_API_KEY` |
| `tavily` | `TAVILY_API_KEY` |
| `exa` | `EXA_API_KEY` |
| `searxng` | your own server's address in `baseUrl` |
| `openrouter-online` | no extra key; uses OpenRouter's built-in web search |

`maxResults` and `fetchPages` set how many search results to consider and how many pages to read in full.

`"autoSetup": "auto"` sets up any new app or site after it has been in front for 4 seconds, once per app. `setupIgnore` lists apps or sites to skip.

## Info keys (live, read-only values)

Any key or dial can show a live value instead of, or as well as, firing an action:

```jsonc
{ "label": "Battery", "icon": "battery",
  "info": { "source": { "type": "command", "cmd": ["/usr/bin/pmset", "-g", "batt"] },
            "extract": "/(\\d+)%/", "format": "{{value}}%", "progress": { "max": 100 }, "every": 120,
            "thresholds": [{ "below": 20, "color": "#EF4444" }] } }
```

**Sources:**

| `type` | Reads |
|---|---|
| `http` | JSON or text from a URL (GET only; secrets allowed) |
| `state` | a value pushed with `deck state` or the API |
| `file` | a file in your home folder |
| `applescript` | the result of a `get` script |
| `command` | the output of a read-only command on the allowlist |
| `uiText` | text on screen in the front window (a pattern with a group), via Accessibility |

**Other fields:**

| Field | What it does |
|---|---|
| `extract` | picks the value: a JSON path (`items[0].statistics.subscriberCount`, `length`) or a `/pattern (group)/` |
| `format` | how the value is shown. Filters: `pct` (0.72 → 72%), `round`, `k` (15320 → 15.3k), `duration`, `until` (time until, e.g. a reset), `ago`, `money` |
| `progress` | `{ "max": … }` draws a progress bar on the key, or on the touch strip for a dial |
| `thresholds` | changes the key's color above or below set values |

Pressing an info key refreshes it. Values only poll while they're on screen.

Usage and reset times for apps like Claude are read from the app's on-screen text (`uiText`) while that screen is visible; I know of no public API for those plan limits. API usage and credits can use the provider's official endpoints with your key.

## Secrets (API keys and tokens for apps)

Layouts declare the secrets they use. Key values are never written to any file.

```jsonc
"secrets": {
  "GITHUB_TOKEN": { "description": "Read-only token", "url": "https://github.com/settings/tokens", "hosts": ["api.github.com"] },
  "HOME_ASSISTANT_URL": { "hosts": [] },
  "HOME_ASSISTANT_TOKEN": { "hosts": ["secret:HOME_ASSISTANT_URL"] }   // = whatever host your stored URL points to
},
"keys": [
  { "label": "GitHub", "requires": ["GITHUB_TOKEN"], "info": { "source": { "type": "http", "url": "https://api.github.com/notifications",
    "headers": { "Authorization": "Bearer {{secret.GITHUB_TOKEN}}" } }, "extract": "length" } },
  { "label": "Studio light", "requires": ["HOME_ASSISTANT_URL", "HOME_ASSISTANT_TOKEN"], "action": { "type": "http", "method": "POST",
    "url": "{{secret.HOME_ASSISTANT_URL}}/api/services/light/toggle", "headers": { "Authorization": "Bearer {{secret.HOME_ASSISTANT_TOKEN}}" },
    "body": { "entity_id": "light.studio" } } }
]
```

- **Missing keys:** a key whose secret isn't stored yet shows **needs NAME**. Press it to get a hidden prompt, and the value goes straight into your credential store. You can also run `deck secret set NAME` or use the app.
- **Host binding:** a secret is only sent to its declared `hosts`. A layout, or a model that wrote one, can't send your key anywhere else.
- **Provider keys:** an `<PROVIDER>_API_KEY` name also finds the LLM provider key you already stored. For example, `OPENROUTER_API_KEY` finds the `openrouter` key.
- **Overview:** `deck secret list` shows every declared secret, where it's used, and whether it's stored. It never shows values.

**Built-in examples:**

| Layout | Secrets | What they power |
|---|---|---|
| `site.studio.youtube.com` | `YOUTUBE_API_KEY` + `YOUTUBE_CHANNEL_ID` | subscriber, view and video counts |
| `app.terminals` | `GITHUB_TOKEN` | GitHub page with notifications and open PRs |

## AI providers

These settings live in `config.json → settings`:

| Setting | Meaning |
|---|---|
| `llm` | provider for the AI keys |
| `setupLlm` | provider for ✨ Set up and research; use a strong model |
| `fallbackLlm` | tried once if the first provider fails |
| `providers` | each provider's model and any settings that differ from its preset |

**Presets** (each only needs a `model`):

| Kind | Providers |
|---|---|
| Anthropic API | `anthropic` |
| OpenAI-compatible | `openai`, `openrouter`, `groq`, `gemini`, `mistral`, `deepseek`, `xai`, `together` |
| Local, no key | `ollama`, `lmstudio` |

Any other OpenAI-compatible server needs `{ "type": "openai", "baseUrl", "model", "noKey"? }`.

Provider keys are stored under the provider id: `deck secret set <id>` (or **AI providers → API key** in the app).

Hold the AI key and choose **AI model** to switch providers. `deck llm test` checks every provider the deck uses.

## Deck menu (hold the AI key)

| Key | What it does |
|---|---|
| ✨ Set up / Update / Rebuild | creates, updates or regenerates the layout for what's in front |
| Edit | opens this layout's file |
| Add key | stores the first missing secret (when one is missing) |
| Folder | opens the layouts folder |
| App | opens the ContextDeck app |
| Pin / Unpin | keeps this layout when you switch apps |
| AI model | switches provider |
| Next page | moves to the next page |

Hand-written layouts are never rebuilt; edit them instead.

## CLI and API

```bash
~/.contextdeck/deck status | page next|sub|app|system | setup [--force|--update] | menus [bundleId]
~/.contextdeck/deck state agent.status=running render.progress=40 | flag recording=true | flash "Done"
~/.contextdeck/deck secret list | secret set NAME | secret rm NAME
~/.contextdeck/deck llm | llm use <id>|default | llm test [id]
~/.contextdeck/deck devices | ui | elgato [tool key=value …] | reload
```

On Windows the CLI is `%USERPROFILE%\.contextdeck\deck.cmd`. It runs on the plugin's own Node, so there's nothing to install.

The local API listens on `127.0.0.1:47811` with `Authorization: Bearer $(cat ~/.contextdeck/token)`. The routes are listed in `src/api.ts`.

**Claude Code hooks for the agent light:**

```json
{ "hooks": {
  "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "~/.contextdeck/deck state agent.status=running >/dev/null" }] }],
  "Notification":     [{ "hooks": [{ "type": "command", "command": "~/.contextdeck/deck state agent.status=waiting >/dev/null" }] }],
  "Stop":             [{ "hooks": [{ "type": "command", "command": "~/.contextdeck/deck state agent.status=done >/dev/null; ~/.contextdeck/deck flash Done >/dev/null" }] }] } }
```

**MCP bridge:**

```bash
# macOS
claude mcp add contextdeck -- node "$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins/com.var.contextdeck.sdPlugin/mcp/contextdeck-mcp.mjs"
# Windows
claude mcp add contextdeck -- node "%APPDATA%\Elgato\StreamDeck\Plugins\com.var.contextdeck.sdPlugin\mcp\contextdeck-mcp.mjs"
```

| Tool | What it does |
|---|---|
| `deck_status` | what the deck shows, levels, page and missing secrets |
| `deck_page` | changes page |
| `deck_ask` | puts options on the keys and waits for your press |
| `deck_show_choices` | puts options on the keys to copy or paste |
| `deck_notify` | flashes a key |
| `deck_set_state` | sets state values |
| `deck_set_flags` | sets context flags |
| `deck_switch` | changes mode or pins a layout |
| `deck_get_config` | returns the full config |
| `deck_upsert_layout` | creates or replaces a layout; it knows the naming, levels and info/secret schema |
| `deck_delete_layout` | deletes a layout |
| `deck_read_menus` | lists an app's real menu items and shortcuts |
| `deck_setup_app` | runs ✨ Set up for what's in front |
| `deck_llm` | lists, switches or tests AI providers |
| `deck_secrets` | lists declared secrets and which are stored (never values) |
| `deck_devices` | the connected decks |
| `deck_elgato_tools` / `deck_elgato_run` | lists and runs official plugin actions |

## Develop

```bash
npm install
npm test            # levels, zones, devices, pages, menus, secrets, info, research, setup, providers, engine, adapters, Elgato bridge
npm run test:e2e    # engine + API + CLI + MCP; the extension in real Chromium (pairing, tab reports); the app in Chromium (desktop + phone)
npm run build       # plugin, CLI, MCP bridge, browser extension
npm run validate && npm run pack
npm run link        # symlink into Stream Deck for live dev; `npm run watch` hot-reloads
```
