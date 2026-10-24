import {
	action, SingletonAction,
	type DialDownEvent, type DialRotateEvent, type KeyDownEvent, type KeyUpEvent, type TouchTapEvent, type WillAppearEvent, type WillDisappearEvent,
} from "@elgato/streamdeck";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonObject = { [key: string]: any };
import type { DeviceInfo, Engine } from "../../engine";
import { DEVICE_KINDS, DIALS_BY_TYPE } from "../../resolve";
import type { SwipePages } from "../../swipe";

/** Profiles bundled with the plugin (scripts/build-profiles.mjs), by device type. */
export const PROFILE_BY_TYPE: Record<number, string> = { 7: "profiles/contextdeck-plus", 0: "profiles/contextdeck-mk2", 1: "profiles/contextdeck-mini", 2: "profiles/contextdeck-xl" };
/** device id → device type, for switching back to the right profile. */
export const deviceTypes = new Map<string, number>();

/** The deck an action lives on, as the engine sees it. */
export function deviceOf(d: { id: string; name?: string; type?: number; size?: { columns: number; rows: number } }): DeviceInfo {
	const cols = d.size?.columns || 4, rows = d.size?.rows || 2;
	const type = d.type ?? 7;
	deviceTypes.set(d.id, type);
	return { id: d.id, name: d.name, kind: DEVICE_KINDS[type] ?? `type${type}`, cols, rows, keys: cols * rows, dials: DIALS_BY_TYPE[type] ?? 0 };
}

type S = JsonObject;

/** One instance per physical key. Its slot is derived from its position, so you just fill every key with it. */
@action({ UUID: "com.var.contextdeck.key" })
export class ContextKey extends SingletonAction<S> {
	private slots = new Map<string, { index: number; device: string }>();
	constructor(private engine: Engine, private swipe?: SwipePages) { super(); }

	override onWillAppear(ev: WillAppearEvent<S>) {
		if (!ev.action.isKey() || ev.action.isInMultiAction()) return;
		const c = ev.action.coordinates;
		if (!c) return;
		const cols = ev.action.device.size?.columns || 4;
		const index = c.row * cols + c.column;
		const a = ev.action;
		const dev = deviceOf(a.device as never);
		this.swipe?.appeared(dev.id, ev.payload.settings?.sdPage);
		this.slots.set(a.id, { index, device: dev.id });
		this.engine.addKey({ id: a.id, setImage: (i) => a.setImage(i), setTitle: (t) => a.setTitle(t), showAlert: () => a.showAlert(), showOk: () => a.showOk() }, index, dev);
	}
	override onWillDisappear(ev: WillDisappearEvent<S>) { this.engine.removeKey(ev.action.id); this.slots.delete(ev.action.id); }
	override onKeyDown(ev: KeyDownEvent<S>) { const s = this.slots.get(ev.action.id); if (s) this.engine.keyDown(s.index, s.device); }
	override onKeyUp(ev: KeyUpEvent<S>) { const s = this.slots.get(ev.action.id); if (s) this.engine.keyUp(s.index, s.device); }
}

/** One instance per dial (Stream Deck +, + XL, Studio, Galleon). Draws its whole touch-strip segment where there is one. */
@action({ UUID: "com.var.contextdeck.dial" })
export class ContextDial extends SingletonAction<S> {
	private slots = new Map<string, { index: number; device: string }>();
	constructor(private engine: Engine, private swipe?: SwipePages) { super(); }

	override onWillAppear(ev: WillAppearEvent<S>) {
		if (!ev.action.isDial()) return;
		const index = ev.action.coordinates.column;
		const a = ev.action;
		const dev = deviceOf(a.device as never);
		this.swipe?.appeared(dev.id, ev.payload.settings?.sdPage);
		this.slots.set(a.id, { index, device: dev.id });
		this.engine.addDial({
			id: a.id,
			setFeedback: (f) => a.setFeedback(f as never),
			setTriggerDescription: (d) => a.setTriggerDescription(d),
			showAlert: () => a.showAlert(),
		}, index, dev);
	}
	override onWillDisappear(ev: WillDisappearEvent<S>) { this.engine.removeDial(ev.action.id); this.slots.delete(ev.action.id); }
	override onDialRotate(ev: DialRotateEvent<S>) { const s = this.slots.get(ev.action.id); if (s) void this.engine.dialRotate(s.index, ev.payload.ticks, s.device); }
	override onDialDown(ev: DialDownEvent<S>) { const s = this.slots.get(ev.action.id); if (s) this.engine.dialPress(s.index, s.device); }
	override onTouchTap(ev: TouchTapEvent<S>) { const s = this.slots.get(ev.action.id); if (s) this.engine.dialTouch(s.index, ev.payload.hold, ev.payload.tapPos?.[0], s.device); }
}
