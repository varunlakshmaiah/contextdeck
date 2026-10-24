// Builds the ContextDeck profiles bundled with the plugin (Stream Deck 7.x "V3" .streamDeckProfile = zip).
// Every key holds a Context Key and every dial a Context Dial, on SWIPE_PAGES identical Stream Deck pages.
// Each action knows its page (settings.sdPage), so a swipe on the touch strip / page change tells ContextDeck
// "next" or "previous"; the plugin then moves back to the middle page so you can always swipe both ways.
//   node scripts/build-profiles.mjs  →  com.var.contextdeck.sdPlugin/profiles/*.streamDeckProfile
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SWIPE_PAGES = 5;
const PLUGIN = "com.var.contextdeck.sdPlugin";
const manifest = JSON.parse(readFileSync(join(PLUGIN, "manifest.json"), "utf8"));

// DeviceType (SDK) → hardware model + grid. Only models whose ids are known for sure.
export const DEVICES = [
	{ file: "contextdeck-plus", type: 7, model: "20GBD9901", cols: 4, rows: 2, dials: 4 },
	{ file: "contextdeck-mk2", type: 0, model: "20GAA9902", cols: 5, rows: 3, dials: 0 },
	{ file: "contextdeck-mini", type: 1, model: "20GAI9902", cols: 3, rows: 2, dials: 0 },
	{ file: "contextdeck-xl", type: 2, model: "20GAT9902", cols: 8, rows: 4, dials: 0 },
];

const U = () => randomUUID().toUpperCase();
const action = (uuid, name, sdPage) => ({
	ActionID: randomUUID(),
	LinkedTitle: true,
	Name: name,
	Plugin: { Name: manifest.Name, UUID: manifest.UUID, Version: manifest.Version },
	Resources: null,
	Settings: { sdPage },
	State: 0,
	States: [{}],
	UUID: uuid,
});

function pageManifest(d, sdPage) {
	const keys = {};
	for (let r = 0; r < d.rows; r++) for (let c = 0; c < d.cols; c++) keys[`${c},${r}`] = action(`${manifest.UUID}.key`, "Context Key", sdPage);
	const controllers = [{ Actions: keys, Type: "Keypad" }];
	if (d.dials) {
		const dials = {};
		for (let c = 0; c < d.dials; c++) dials[`${c},0`] = action(`${manifest.UUID}.dial`, "Context Dial", sdPage);
		controllers.push({ Actions: dials, Type: "Encoder" });
	}
	return { Controllers: controllers, Icon: "", Name: "" };
}

export function buildProfile(d, outFile) {
	const dir = mkdtempSync(join(tmpdir(), "cdprofile-"));
	try {
		const root = join(dir, "Profiles", `${U()}.sdProfile`);
		const defaultPage = U();                       // Stream Deck keeps a separate (empty) default page
		const pages = Array.from({ length: SWIPE_PAGES }, U);
		mkdirSync(join(root, "Profiles", defaultPage), { recursive: true });
		writeFileSync(join(root, "Profiles", defaultPage, "manifest.json"), JSON.stringify({ Controllers: [{ Actions: null, Type: "Keypad" }], Icon: "", Name: "" }, null, 2));
		pages.forEach((p, i) => {
			mkdirSync(join(root, "Profiles", p), { recursive: true });
			writeFileSync(join(root, "Profiles", p, "manifest.json"), JSON.stringify(pageManifest(d, i), null, 2));
		});
		writeFileSync(join(root, "manifest.json"), JSON.stringify({
			Device: { Model: d.model, UUID: "" },
			Name: "ContextDeck",
			Pages: { Current: "00000000-0000-0000-0000-000000000000", Default: defaultPage, Pages: pages },
			Version: "3.0",
		}, null, 2));
		writeFileSync(join(dir, "package.json"), JSON.stringify({
			AppVersion: "7.6.0.23012", DeviceModel: d.model, DeviceSettings: null, FormatVersion: 1, OSType: "macOS", OSVersion: "15.0", RequiredPlugins: [manifest.UUID],
		}, null, 2));
		rmSync(outFile, { force: true });
		execFileSync("zip", ["-qrX", outFile, "package.json", "Profiles"], { cwd: dir });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

if (process.argv[1]?.endsWith("build-profiles.mjs")) {
	const out = join(process.cwd(), PLUGIN, "profiles");
	mkdirSync(out, { recursive: true });
	for (const d of DEVICES) { buildProfile(d, join(out, `${d.file}.streamDeckProfile`)); console.log(`built profiles/${d.file}.streamDeckProfile`); }
	// Register them in the manifest: installed (and switched to) with the plugin.
	manifest.Profiles = DEVICES.map((d) => ({ Name: `profiles/${d.file}`, DeviceType: d.type, AutoInstall: true, DontAutoSwitchWhenInstalled: false, Readonly: false }));
	writeFileSync(join(PLUGIN, "manifest.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
}
