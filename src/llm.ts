/**
 * Provider-agnostic LLM calls. Two wire formats cover almost everything:
 *   - "anthropic": Anthropic Messages API
 *   - "openai":    OpenAI-style /chat/completions (OpenAI, OpenRouter, Groq, Gemini, Mistral, DeepSeek, xAI, Together, Ollama, LM Studio, vLLM…)
 *
 * Providers are named in settings.providers and merged over the presets below, so {"openrouter": {"model": "…"}} is enough.
 * API keys live in the macOS Keychain:  security add-generic-password -s contextdeck -a <provider name> -w "KEY"
 */
import { keychainSecret } from "./mac";

export interface ProviderDef {
	type?: "anthropic" | "openai";
	name?: string;                   // display name on keys ("OpenRouter")
	baseUrl?: string;                // e.g. https://openrouter.ai/api/v1  (without /chat/completions)
	model?: string;                  // default model for this provider
	keychain?: string;               // Keychain account name (default: the provider's id)
	apiKeyEnv?: string;              // env var fallback (default: <ID>_API_KEY)
	noKey?: boolean;                 // local servers (Ollama, LM Studio)
	headers?: Record<string, string>;
	maxTokensParam?: "max_tokens" | "max_completion_tokens";
	jsonMode?: boolean;              // send response_format json_object when JSON is wanted
	timeoutMs?: number;
}

export const PRESETS: Record<string, ProviderDef> = {
	anthropic: { type: "anthropic", name: "Claude", baseUrl: "https://api.anthropic.com/v1", apiKeyEnv: "ANTHROPIC_API_KEY", model: "claude-sonnet-5-5" },
	openai: { type: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY", maxTokensParam: "max_completion_tokens", jsonMode: true },
	openrouter: { type: "openai", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY", headers: { "HTTP-Referer": "https://github.com/contextdeck", "X-Title": "ContextDeck" } },
	groq: { type: "openai", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", apiKeyEnv: "GROQ_API_KEY", jsonMode: true },
	gemini: { type: "openai", name: "Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", apiKeyEnv: "GEMINI_API_KEY", jsonMode: true },
	mistral: { type: "openai", name: "Mistral", baseUrl: "https://api.mistral.ai/v1", apiKeyEnv: "MISTRAL_API_KEY", jsonMode: true },
	deepseek: { type: "openai", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", apiKeyEnv: "DEEPSEEK_API_KEY", jsonMode: true },
	xai: { type: "openai", name: "Grok", baseUrl: "https://api.x.ai/v1", apiKeyEnv: "XAI_API_KEY" },
	together: { type: "openai", name: "Together", baseUrl: "https://api.together.xyz/v1", apiKeyEnv: "TOGETHER_API_KEY" },
	ollama: { type: "openai", name: "Ollama", baseUrl: "http://localhost:11434/v1", noKey: true, timeoutMs: 180_000 },
	lmstudio: { type: "openai", name: "LM Studio", baseUrl: "http://localhost:1234/v1", noKey: true, timeoutMs: 180_000 },
};

export interface LlmSettings {
	providers?: Record<string, ProviderDef>;
	llm?: string;          // default provider id
	setupLlm?: string;     // provider for ✨ Set up
	fallbackLlm?: string;  // retried once when the chosen provider fails or returns nothing usable
	model?: string;        // legacy: default model for the anthropic provider
	setupModel?: string;   // legacy: model for setup on the default provider
}

export interface Resolved { id: string; def: Required<Pick<ProviderDef, "type" | "baseUrl">> & ProviderDef }

/** Ids of providers the user configured (plus anthropic, always available). */
export function configuredProviders(s: LlmSettings): string[] {
	return [...new Set(["anthropic", ...Object.keys(s.providers ?? {})])].filter((id) => id === "anthropic" || resolveProvider(s, id));
}

export function resolveProvider(s: LlmSettings, id: string): Resolved | undefined {
	const preset = PRESETS[id];
	const user = s.providers?.[id];
	if (!preset && !user) return undefined;
	const def = { ...preset, ...user, headers: { ...preset?.headers, ...user?.headers } } as ProviderDef;
	if (id === "anthropic" && !user?.model && s.model) def.model = s.model;
	def.type ??= "openai";
	if (!def.baseUrl) return undefined;
	return { id, def: def as Resolved["def"] };
}

export const providerName = (s: LlmSettings, id: string) => resolveProvider(s, id)?.def.name ?? id;

async function apiKey(p: Resolved): Promise<string | undefined> {
	if (p.def.noKey) return undefined;
	const account = p.def.keychain ?? p.id;
	const fromKeychain = await keychainSecret("contextdeck", account);
	if (fromKeychain) return fromKeychain;
	const env = p.def.apiKeyEnv ?? `${p.id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
	if (process.env[env]) return process.env[env];
	throw new Error(`No API key for ${p.def.name ?? p.id}. Run: security add-generic-password -s contextdeck -a ${account} -w YOUR_KEY`);
}

export interface AskOptions {
	provider?: string;
	model?: string;
	prompt: string;
	input?: string;
	system?: string;
	maxTokens?: number;
	json?: boolean;
}

export const DEFAULT_SYSTEM = "You are a hardware shortcut on a Stream Deck. Return only the requested output: no preamble, no explanation, no markdown fences unless the output is code.";

function errorText(status: number, body: string, who: string): string {
	let msg = body;
	try {
		const j = JSON.parse(body);
		msg = j?.error?.message ?? j?.error?.metadata?.raw ?? j?.message ?? (typeof j?.error === "string" ? j.error : body);
	} catch { /* not JSON */ }
	return `${who} ${status}: ${String(msg).replace(/\s+/g, " ").slice(0, 220)}`;
}

/** Calls the chosen provider and returns plain text. `fetchImpl` is injectable for tests. */
export async function askLLM(s: LlmSettings, o: AskOptions, fetchImpl: typeof fetch = fetch): Promise<{ text: string; provider: string; model: string }> {
	const id = o.provider ?? s.llm ?? "anthropic";
	const p = resolveProvider(s, id);
	if (!p) throw new Error(`Unknown LLM provider "${id}". Add it under settings.providers (needs at least baseUrl and model).`);
	const model = o.model ?? p.def.model;
	if (!model) throw new Error(`No model set for provider "${id}". Add "model" under settings.providers.${id}.`);
	const key = await apiKey(p);
	const who = p.def.name ?? id;
	const content = o.input ? `${o.prompt}\n\n<input>\n${o.input}\n</input>` : o.prompt;
	const system = o.system ?? DEFAULT_SYSTEM;
	const maxTokens = o.maxTokens ?? 1024;
	const signal = AbortSignal.timeout(p.def.timeoutMs ?? 90_000);
	const base = p.def.baseUrl.replace(/\/+$/, "");

	if (p.def.type === "anthropic") {
		const res = await fetchImpl(`${base}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...(key ? { "x-api-key": key } : {}), ...p.def.headers },
			body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content }] }),
			signal,
		});
		const body = await res.text();
		if (!res.ok) throw new Error(errorText(res.status, body, who));
		const data = JSON.parse(body) as { content?: { type: string; text?: string }[] };
		return { text: (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("").trim(), provider: id, model };
	}

	const send = async (jsonMode: boolean) => {
		const payload: Record<string, unknown> = {
			model,
			messages: [{ role: "system", content: system }, { role: "user", content }],
			[p.def.maxTokensParam ?? "max_tokens"]: maxTokens,
		};
		if (jsonMode) payload.response_format = { type: "json_object" };
		return fetchImpl(`${base}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}), ...p.def.headers },
			body: JSON.stringify(payload),
			signal,
		});
	};
	const wantJson = !!o.json && !!p.def.jsonMode;
	let res = await send(wantJson);
	let body = await res.text();
	if (!res.ok && wantJson && res.status >= 400 && res.status < 500) {
		res = await send(false); // provider/model doesn't support JSON mode
		body = await res.text();
	}
	if (!res.ok) throw new Error(errorText(res.status, body, who));
	const data = JSON.parse(body) as { choices?: { message?: { content?: string | { type: string; text?: string }[]; reasoning?: string } }[]; error?: { message?: string } };
	if (data.error?.message) throw new Error(`${who}: ${data.error.message}`);
	const c = data.choices?.[0]?.message?.content;
	const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((part) => part.text ?? "").join("") : "";
	return { text: stripThinking(text).trim(), provider: id, model };
}

/** Some open models wrap reasoning in <think>…</think>; drop it. */
export const stripThinking = (t: string) => t.replace(/<think>[\s\S]*?<\/think>/gi, "");

/** For output "choices": up to 7 short options, one per line. */
export function parseChoices(text: string): string[] {
	return text
		.split("\n")
		.map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(/^"(.*)"$/, "$1").trim())
		.filter(Boolean)
		.slice(0, 7);
}
