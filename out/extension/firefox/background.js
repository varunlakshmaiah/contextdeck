// ContextDeck browser extension: tells the deck which tab is in front (URL + title), so site layouts
// work exactly on every OS — including Linux, where the OS can't read browser tabs.
// Talks only to 127.0.0.1 (your ContextDeck plugin). Nothing leaves your computer.
const api = globalThis.browser ?? globalThis.chrome;
const DEFAULT_PORT = 47811;

async function settings() {
	const s = await api.storage.local.get(["token", "port", "skipIncognito"]);
	return { token: s.token ?? "", port: Number(s.port) || DEFAULT_PORT, skipIncognito: s.skipIncognito !== false };
}

function browserName() {
	const brands = navigator.userAgentData?.brands?.map((b) => b.brand) ?? [];
	if (navigator.brave) return "Brave";
	for (const n of ["Microsoft Edge", "Opera", "Vivaldi", "Google Chrome", "Chromium"]) if (brands.includes(n)) return n;
	if (/Firefox\//.test(navigator.userAgent)) return "Firefox";
	return "Browser";
}

let last = "";
async function report(tab, focused) {
	const { token, port, skipIncognito } = await settings();
	if (!token) return;
	const incognito = !!tab?.incognito;
	const body = {
		url: incognito && skipIncognito ? "" : tab?.url ?? "",
		title: incognito && skipIncognito ? "" : tab?.title ?? "",
		browser: browserName(),
		focused,
		incognito,
	};
	const key = JSON.stringify(body);
	if (key === last) return;
	last = key;
	try {
		const res = await fetch(`http://127.0.0.1:${port}/context/browser`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: key,
		});
		await api.storage.local.set({ status: res.ok ? "connected" : res.status === 401 ? "bad token" : `error ${res.status}`, statusAt: Date.now() });
	} catch {
		last = "";
		await api.storage.local.set({ status: "ContextDeck not running", statusAt: Date.now() });
	}
}

async function current() {
	const win = await api.windows.getLastFocused({ populate: false }).catch(() => undefined);
	if (!win) return;
	const [tab] = await api.tabs.query({ active: true, windowId: win.id });
	await report(tab, !!win.focused);
}

api.tabs.onActivated.addListener(() => void current());
api.tabs.onUpdated.addListener((_id, info, tab) => { if (tab.active && (info.url || info.title || info.status === "complete")) void current(); });
api.windows.onFocusChanged.addListener((id) => {
	if (id === api.windows.WINDOW_ID_NONE) { last = ""; void report(undefined, false); }
	else void current();
});
api.runtime.onStartup?.addListener(() => void current());
api.runtime.onInstalled.addListener((d) => { if (d.reason === "install") api.runtime.openOptionsPage(); void current(); });
api.storage.onChanged.addListener((c) => { if (c.token || c.port) { last = ""; void current(); } });
// Keep the deck's view fresh if it restarts (alarms wake the service worker).
api.alarms.create("contextdeck-refresh", { periodInMinutes: 1 });
api.alarms.onAlarm.addListener(() => { last = ""; void current(); });

// Pairing, started from the options page: the deck asks you to press Allow.
api.runtime.onMessage.addListener((msg, _sender, reply) => {
	if (msg?.type !== "pair") return;
	(async () => {
		const { port } = await settings();
		try {
			const res = await fetch(`http://127.0.0.1:${port}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client: `${browserName()} extension` }) });
			const j = await res.json();
			if (j.token) { await api.storage.local.set({ token: j.token }); reply({ ok: true }); }
			else reply({ ok: false, error: j.error ?? `HTTP ${res.status}` });
		} catch {
			reply({ ok: false, error: "ContextDeck isn't running (open the Stream Deck app or OpenDeck)." });
		}
	})();
	return true;
});
