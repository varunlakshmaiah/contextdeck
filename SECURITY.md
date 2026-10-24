# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Report them privately through [GitHub's private vulnerability reporting](https://github.com/varunlakshmaiah/contextdeck/security/advisories/new).

Include what's affected, how to reproduce it, and what an attacker could do. You'll get a reply within a week. Fixes go into a new release, and you'll be credited in the advisory unless you'd rather not be.

## Supported versions

Only the latest release gets security fixes.

## How ContextDeck protects you

ContextDeck runs on your computer, can press keys, and can call web APIs with your keys. These are the protections, and reports that break any of them are especially welcome:

- **Secrets stay in your OS credential store.** API keys and tokens go into the macOS Keychain, Windows Credential Manager or libsecret. They are never written to layout or config files, and the API and app never return their values.
- **Secrets only go where they're declared.** A `{{secret.NAME}}` is only sent to the hosts that secret is declared for, so a layout, or an AI model that wrote one, can't send your key anywhere else.
- **The local API is local.** It listens on `127.0.0.1` only, requires a bearer token from `~/.contextdeck/token`, and refuses requests whose `Host` isn't `127.0.0.1` or `localhost`, which blocks DNS rebinding. Requests from any browser origin other than the ContextDeck extension or the app's own page are refused.
- **Pairing needs a physical key press.** The browser extension only gets the API token after you press **Allow** on your Stream Deck.
- **Generated layouts can only read.** Info sources in layouts written by ✨ Set up are checked: only GET requests, a short list of read-only commands, read-only AppleScript, and files inside your home folder (not keys or keychains). Shell commands an AI suggests are never run automatically.
- **The app's token stays out of the network.** The token travels in the URL fragment, which browsers never send, and is removed from the address bar on load.
