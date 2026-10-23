/** Helpers shared by the platform adapters. */

/** Copy the current selection by sending the copy shortcut and waiting for the clipboard to change. */
export async function copyViaClipboard(get: () => Promise<string>, set: (t: string) => Promise<void>, pressCopy: () => Promise<void>): Promise<string> {
	const marker = `__contextdeck_${Date.now()}__`;
	const previous = await get().catch(() => "");
	await set(marker);
	await pressCopy();
	for (let i = 0; i < 15; i++) {
		await new Promise((r) => setTimeout(r, 60));
		const now = await get().catch(() => marker);
		if (now !== marker) return now;
	}
	await set(previous);
	return "";
}

/** Browser window titles end with the browser name; strip it to get the tab title. */
export const stripBrowserSuffix = (title: string) =>
	title.replace(/\s+[-–—]\s+(Google Chrome|Microsoft​? Edge|Brave|Mozilla Firefox|Firefox|Vivaldi|Opera|Chromium|Arc)( Beta| Dev| Canary| Nightly)?$/i, "").replace(/\s+-\s+Personal$/, "").trim();

/** Address-bar text often omits the scheme. */
export const normalizeUrl = (v: string) => {
	const t = v.trim();
	if (!t || /\s/.test(t)) return "";
	return /^[a-z][\w+.-]*:/i.test(t) ? t : `https://${t}`;
};
