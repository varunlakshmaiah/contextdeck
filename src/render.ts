import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let ICONS: Record<string, string> | null = null;

/** Loads lucide icon bodies (name -> inner SVG) from the plugin folder. */
export function loadIcons(file?: string): Record<string, string> {
	if (ICONS) return ICONS;
	const path = file ?? join(dirname(fileURLToPath(import.meta.url)), "..", "icons.json");
	try {
		ICONS = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		ICONS = {};
	}
	return ICONS!;
}

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const FONT = `font-family="-apple-system, 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif"`;

export const toDataUrl = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;

function fitFont(text: string, max: number, width: number, factor = 0.58): number {
	if (!text) return max;
	return Math.max(11, Math.min(max, Math.floor(width / (text.length * factor))));
}

function icon(name: string | undefined, x: number, y: number, size: number, color: string): string {
	if (!name) return "";
	const body = loadIcons()[name];
	if (!body) return "";
	const s = size / 24;
	return `<g transform="translate(${x} ${y}) scale(${s})" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</g>`;
}

export interface KeyVisual {
	label: string;
	sub?: string;
	icon?: string;
	glyph?: string;
	color: string;        // accent
	bg: string;
	stripe?: string;      // layout color
	status?: string;      // status light color
	pressed?: boolean;
	empty?: boolean;
	bar?: number;         // 0..1 progress bar along the bottom (info keys)
	dim?: boolean;        // inactive (e.g. needs a secret)
}

export function renderKey(v: KeyVisual): string {
	const W = 144;
	if (v.empty) {
		return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" viewBox="0 0 ${W} ${W}"><rect width="${W}" height="${W}" fill="${v.bg}"/>${v.stripe ? `<rect width="${W}" height="5" fill="${v.stripe}" opacity="0.35"/>` : ""}</svg>`;
	}
	const hasVisual = !!(v.icon && loadIcons()[v.icon]) || !!v.glyph || !!v.status;
	const labelY = hasVisual ? (v.sub ? 112 : 122) : (v.sub ? 72 : 82);
	const lf = fitFont(v.label, hasVisual ? 22 : 30, 132);
	const parts: string[] = [];
	parts.push(`<rect width="${W}" height="${W}" fill="${v.bg}"/>`);
	if (v.pressed) parts.push(`<rect width="${W}" height="${W}" fill="${v.color}" opacity="0.22"/>`);
	if (v.stripe) parts.push(`<rect width="${W}" height="5" fill="${v.stripe}"/>`);

	if (v.status) {
		parts.push(`<circle cx="72" cy="${v.sub ? 52 : 56}" r="26" fill="${v.status}" opacity="0.18"/>`);
		parts.push(`<circle cx="72" cy="${v.sub ? 52 : 56}" r="15" fill="${v.status}"/>`);
	} else if (v.icon && loadIcons()[v.icon]) {
		const size = 56;
		parts.push(icon(v.icon, 72 - size / 2, (v.sub ? 50 : 54) - size / 2, size, v.color));
	} else if (v.glyph) {
		const gf = fitFont(v.glyph, 54, 120, 0.62);
		parts.push(`<text x="72" y="${(v.sub ? 52 : 56) + gf * 0.35}" text-anchor="middle" ${FONT} font-size="${gf}" font-weight="700" fill="${v.color}">${esc(v.glyph)}</text>`);
	}
	if (v.label) parts.push(`<text x="72" y="${labelY}" text-anchor="middle" ${FONT} font-size="${lf}" font-weight="600" fill="#F4F4F5">${esc(v.label)}</text>`);
	if (v.sub) {
		const sf = fitFont(v.sub, 16, 132);
		parts.push(`<text x="72" y="${labelY + sf + 6}" text-anchor="middle" ${FONT} font-size="${sf}" fill="#A1A1AA">${esc(v.sub)}</text>`);
	}
	if (v.bar !== undefined) {
		const b = Math.max(0, Math.min(1, v.bar));
		parts.push(`<rect x="10" y="134" width="124" height="5" rx="2.5" fill="#3F3F46"/><rect x="10" y="134" width="${Math.max(5, 124 * b)}" height="5" rx="2.5" fill="${v.color}"/>`);
	}
	if (v.dim) parts.push(`<rect width="${W}" height="${W}" fill="${v.bg}" opacity="0.45"/>`);
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" viewBox="0 0 ${W} ${W}">${parts.join("")}</svg>`;
}

export interface DialVisual {
	label: string;
	value?: string;
	icon?: string;
	color: string;
	bg: string;
	stripe?: string;
	bar?: number;   // 0..1, omitted = no bar
	hint?: string;  // e.g. "◀ ▶  press: reset"
	prev?: boolean; // page chevron on the left edge
	next?: boolean; // page chevron on the right edge
	pageText?: string; // "2/4 YouTube" in the corner
}

export function renderDial(v: DialVisual): string {
	const W = 200, H = 100;
	const parts: string[] = [`<rect width="${W}" height="${H}" fill="${v.bg}"/>`];
	if (v.stripe) parts.push(`<rect width="${W}" height="4" fill="${v.stripe}"/>`);
	if (v.prev) parts.push(`<path d="M7 42 L2 50 L7 58" fill="none" stroke="#71717A" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`);
	if (v.next) parts.push(`<path d="M193 42 L198 50 L193 58" fill="none" stroke="#71717A" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`);
	if (v.pageText) parts.push(`<text x="${W - 8}" y="18" text-anchor="end" ${FONT} font-size="11" fill="#71717A">${esc(v.pageText)}</text>`);
	const hasIcon = !!(v.icon && loadIcons()[v.icon]);
	if (hasIcon) parts.push(icon(v.icon, 12, 30, 34, v.color));
	const tx = hasIcon ? 56 : 14;
	const hasValue = v.value !== undefined && v.value !== "";
	if (!hasValue && v.bar === undefined) {
		// Action dial: big label beside the icon, hint underneath.
		parts.push(`<text x="${tx}" y="58" ${FONT} font-size="${fitFont(v.label, 26, W - tx - 8)}" font-weight="700" fill="#FAFAFA">${esc(v.label)}</text>`);
		if (v.hint) parts.push(`<text x="${tx}" y="82" ${FONT} font-size="14" fill="#71717A">${esc(v.hint)}</text>`);
		return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;
	}
	parts.push(`<text x="${tx}" y="28" ${FONT} font-size="${fitFont(v.label, 17, W - tx - 8)}" font-weight="600" fill="#D4D4D8">${esc(v.label)}</text>`);
	if (hasValue) {
		parts.push(`<text x="${tx}" y="64" ${FONT} font-size="${fitFont(v.value!, 30, W - tx - 10, 0.6)}" font-weight="700" fill="#FAFAFA">${esc(v.value!)}</text>`);
	}
	if (v.bar !== undefined) {
		const b = Math.max(0, Math.min(1, v.bar));
		parts.push(`<rect x="14" y="80" width="172" height="7" rx="3.5" fill="#3F3F46"/>`);
		parts.push(`<rect x="14" y="80" width="${Math.max(7, 172 * b)}" height="7" rx="3.5" fill="${v.color}"/>`);
	} else if (v.hint) {
		parts.push(`<text x="${tx}" y="88" ${FONT} font-size="12" fill="#71717A">${esc(v.hint)}</text>`);
	}
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;
}
