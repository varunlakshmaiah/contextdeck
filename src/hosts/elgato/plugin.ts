import streamDeck from "@elgato/streamdeck";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { platform } from "../../platform";
import { join } from "node:path";
import { ContextDial, ContextKey } from "./actions";
import { startApi } from "../../api";
import { CONFIG_PATH, HOME_DIR, ensureHome, loadConfig, readToken, watchConfig } from "../../config";
import { Engine } from "../../engine";

const VERSION = "0.5.0";
const log = streamDeck.logger.createScope("ContextDeck");
streamDeck.logger.setLevel("info");

// Recent log lines + current state go to ~/.contextdeck/debug.json so problems are visible outside the plugin folder.
const recent: string[] = [];
let debugTimer: NodeJS.Timeout | undefined;
const writeDebug = () => {
	clearTimeout(debugTimer);
	debugTimer = setTimeout(() => {
		try {
			writeFileSync(join(HOME_DIR, "debug.json"), JSON.stringify({ version: VERSION, written: new Date().toISOString(), ...engine.snapshot(), log: recent }, null, 2));
		} catch { /* ignore */ }
	}, 250);
};

const engine = new Engine();
engine.log = (m) => {
	log.info(m);
	recent.push(`${new Date().toISOString().slice(11, 19)} ${m}`);
	if (recent.length > 60) recent.shift();
	writeDebug();
};
engine.onDiag = writeDebug;

ensureHome();
engine.log(`ContextDeck ${VERSION} starting`);
const load = () => {
	const { config, errors, sources } = loadConfig(CONFIG_PATH);
	if (config) engine.sources = sources;
	engine.setConfig(config, errors);
};
engine.reloadConfig = load;

const SETUP_STATE = join(HOME_DIR, "setup-state.json");
try { engine.setupState = JSON.parse(readFileSync(SETUP_STATE, "utf8")); } catch { /* first run */ }
// Keep the last menu scan per app in ~/.contextdeck/menus/ (handy for hand-editing layouts, and for Claude via MCP).
engine.deps.scanMenus = async (bundleId) => {
	const entries = await platform().scanMenus(bundleId);
	try {
		mkdirSync(join(HOME_DIR, "menus"), { recursive: true });
		writeFileSync(join(HOME_DIR, "menus", `${bundleId}.txt`), entries.map((e) => `${e.path.join(" > ")}${e.chord ? `\t[${e.chord}]` : ""}`).join("\n"));
	} catch { /* ignore */ }
	return entries;
};
const PREFS = join(HOME_DIR, "prefs.json");
try { engine.llmOverride = JSON.parse(readFileSync(PREFS, "utf8")).llm ?? null; } catch { /* none yet */ }
engine.deps.savePrefs = (p) => { try { writeFileSync(PREFS, JSON.stringify(p, null, 2)); } catch { /* ignore */ } };
// Research digests are cached per app version: research/<layout id>@<version>.json
const RESEARCH_DIR = join(HOME_DIR, "research");
const researchFile = (key: string) => join(RESEARCH_DIR, `${key.replace(/[^\w.@-]+/g, "_")}.json`);
engine.deps.loadResearch = (key) => { try { return JSON.parse(readFileSync(researchFile(key), "utf8")); } catch { return undefined; } };
engine.deps.saveResearch = (key, d) => { try { mkdirSync(RESEARCH_DIR, { recursive: true }); writeFileSync(researchFile(key), JSON.stringify(d, null, 2)); } catch { /* ignore */ } };
engine.deps.saveSetupState = (st) => { try { writeFileSync(SETUP_STATE, JSON.stringify(st, null, 2)); } catch { /* ignore */ } };
load();
watchConfig(() => { engine.log("config/layouts changed, reloading"); load(); });

streamDeck.actions.registerAction(new ContextKey(engine));
streamDeck.actions.registerAction(new ContextDial(engine));

startApi(engine, engine.settings.apiPort ?? 47811, readToken());
engine.start();
engine.on("context", writeDebug);

process.on("uncaughtException", (e) => engine.log(`uncaught: ${e.stack ?? e.message}`));
process.on("unhandledRejection", (e) => engine.log(`unhandled: ${(e as Error)?.stack ?? String(e)}`));

streamDeck.connect();
