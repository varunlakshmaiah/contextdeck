/**
 * The active OS adapter. The core calls platform() and never imports an adapter directly,
 * so tests can swap in a fake with setPlatform().
 */
import { makeLinuxPlatform } from "./linux";
import { macPlatform } from "./mac";
import type { OsId, Platform } from "./types";
import { makeWinPlatform, PsHost } from "./win";

export type { Front, OsId, Platform, PlatformFacts, Capabilities } from "./types";
export { Unsupported } from "./types";

let cmdKey: "ctrl" | "win" = "ctrl";
let current: Platform | undefined;

export const osId = (p: NodeJS.Platform = process.platform): OsId => (p === "darwin" ? "mac" : p === "win32" ? "win" : "linux");

export function makePlatform(id: OsId = osId()): Platform {
	if (id === "mac") return macPlatform;
	if (id === "win") return makeWinPlatform(new PsHost(), () => cmdKey);
	return makeLinuxPlatform(() => cmdKey);
}

export function platform(): Platform {
	return (current ??= makePlatform());
}

export function setPlatform(p: Platform | undefined) { current = p; }

/** What "cmd" in a layout's keys means on Windows/Linux (settings.cmdKey). Ignored on macOS. */
export function setCmdKey(k: "ctrl" | "win" | undefined) { cmdKey = k === "win" ? "win" : "ctrl"; }
