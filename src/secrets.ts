/**
 * Secrets: API keys/tokens referenced as {{secret.NAME}} in http actions and info sources.
 *
 *  - Stored only in the OS credential store (macOS Keychain / Windows Credential Manager / libsecret),
 *    service "contextdeck", account NAME. Never in layout files.
 *  - NAME is UPPER_SNAKE: <SERVICE>_<KIND>, KIND ∈ API_KEY | TOKEN | URL | SECRET.
 *  - A secret is only substituted into a request whose host matches its declared `hosts`,
 *    so a layout (or a model that wrote it) can't send your key somewhere else.
 *  - hosts may include "secret:OTHER_NAME" = the host of another stored URL secret (e.g. a self-hosted server).
 *  - <PROVIDER>_API_KEY falls back to the LLM provider's key (e.g. OPENROUTER_API_KEY → "openrouter").
 */
import { platform } from "./platform";
import { glob } from "./resolve";
import type { SecretDecl } from "./types";

export const SECRET_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
const PLACEHOLDER = /\{\{\s*secret\.([A-Za-z0-9_]+)\s*\}\}/g;

export interface SecretStore {
	get(name: string): Promise<string | undefined>;
	set(name: string, value: string): Promise<void>;
	forget?(name?: string): void;
}

/** OS credential store with a short cache (keychain reads cost ~30–60 ms). */
export function keychainStore(ttlMs = 60_000): SecretStore & { forget(name?: string): void; remove(name: string): Promise<void> } {
	const cache = new Map<string, { v: string | undefined; at: number }>();
	return {
		async get(name) {
			const hit = cache.get(name);
			if (hit && Date.now() - hit.at < (hit.v ? ttlMs : 10_000)) return hit.v;
			let v = await platform().secretGet(name);
			const alias = /^([A-Z0-9]+)_API_KEY$/.exec(name);
			if (!v && alias) v = await platform().secretGet(alias[1].toLowerCase());
			cache.set(name, { v, at: Date.now() });
			return v;
		},
		async set(name, value) {
			if (!SECRET_NAME.test(name)) throw new Error(`Secret names are UPPER_SNAKE_CASE (got "${name}")`);
			await platform().secretSet(name, value);
			cache.delete(name);
		},
		async remove(name: string) { await platform().secretDelete(name); cache.delete(name); },
		forget(name) { if (name) cache.delete(name); else cache.clear(); },
	};
}

export function memoryStore(init: Record<string, string> = {}): SecretStore {
	const m = new Map(Object.entries(init));
	return { get: async (n) => m.get(n), set: async (n, v) => void m.set(n, v) };
}

export const secretNames = (text: string): string[] => [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]))];

const hostOf = (url: string) => {
	try { return new URL(url).hostname; } catch { return ""; }
};

/**
 * Replaces {{secret.NAME}} in every string of `parts`, after checking each NAME is declared
 * with a `hosts` list that includes the request's host. Throws a readable error otherwise.
 */
export async function withSecrets<T>(parts: T, url: string, decls: Record<string, SecretDecl>, store: SecretStore): Promise<T> {
	const json = JSON.stringify(parts);
	const names = secretNames(json);
	if (!names.length) return parts;
	const values: Record<string, string> = {};
	const load = async (n: string) => {
		if (!decls[n]) throw new Error(`Secret ${n} isn't declared. Add "secrets": { "${n}": { "hosts": ["api.example.com"] } } to the layout.`);
		const v = await store.get(n);
		if (!v) throw new MissingSecretError(n);
		values[n] = v;
	};
	// A secret at the very start of the URL (e.g. {{secret.HOME_ASSISTANT_URL}}/api/…) *is* the destination you stored.
	const lead = /^\s*\{\{\s*secret\.([A-Za-z0-9_]+)\s*\}\}/.exec(url)?.[1];
	if (lead) await load(lead);
	const realUrl = url.replace(PLACEHOLDER, (_, n: string) => values[n] ?? "x.invalid");
	const host = hostOf(realUrl);
	for (const n of names) {
		if (n === lead) continue;
		if (!decls[n]) await load(n); // throws "not declared"
		const allowed: string[] = [];
		for (const h of decls[n].hosts ?? []) {
			// "secret:HOME_ASSISTANT_URL" = whatever host that stored URL points to
			if (h.startsWith("secret:")) { const v = await store.get(h.slice(7)); if (v) allowed.push(hostOf(v)); }
			else allowed.push(h);
		}
		if (!allowed.some((h) => h && glob(h, host))) throw new Error(`Secret ${n} may not be sent to ${host || "this URL"} (allowed: ${allowed.join(", ") || "none"})`);
		await load(n);
	}
	const esc = (s: string) => JSON.stringify(s).slice(1, -1);
	return JSON.parse(json.replace(PLACEHOLDER, (_, n: string) => esc(values[n]))) as T;
}

export class MissingSecretError extends Error {
	constructor(public secret: string) {
		super(`Needs ${secret}. Run: ~/.contextdeck/deck secret set ${secret}`);
	}
}

export async function missingSecrets(names: string[] | undefined, store: SecretStore): Promise<string[]> {
	const out: string[] = [];
	for (const n of names ?? []) if (!(await store.get(n))) out.push(n);
	return out;
}
