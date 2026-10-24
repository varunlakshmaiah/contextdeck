const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

async function load() {
	const s = await api.storage.local.get(["token", "port", "skipIncognito", "status"]);
	$("token").value = s.token ?? "";
	$("port").value = s.port ?? "";
	$("skipIncognito").checked = s.skipIncognito !== false;
	const st = s.token ? s.status ?? "waiting for a tab change" : "not connected";
	$("status").textContent = st;
	$("status").className = st === "connected" ? "ok" : s.token ? "bad" : "";
}

$("pair").addEventListener("click", async () => {
	$("pairMsg").textContent = "Press Allow on your Stream Deck…";
	const r = await api.runtime.sendMessage({ type: "pair" });
	$("pairMsg").textContent = r?.ok ? "Connected." : r?.error ?? "Failed";
	load();
});
$("save").addEventListener("click", async () => {
	await api.storage.local.set({ token: $("token").value.trim(), port: Number($("port").value) || undefined });
	load();
});
$("skipIncognito").addEventListener("change", () => api.storage.local.set({ skipIncognito: $("skipIncognito").checked }));
api.storage.onChanged.addListener(load);
load();
