import {
	action, SingletonAction,
	type DialDownEvent, type DialRotateEvent, type KeyDownEvent, type KeyUpEvent, type TouchTapEvent, type WillAppearEvent, type WillDisappearEvent,
} from "@elgato/streamdeck";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonObject = { [key: string]: any };
import type { Engine } from "./engine";

type S = JsonObject;

/** One instance per physical key. Its slot is derived from its position, so you just fill every key with it. */
@action({ UUID: "com.var.contextdeck.key" })
export class ContextKey extends SingletonAction<S> {
	private slots = new Map<string, number>();
	constructor(private engine: Engine) { super(); }

	override onWillAppear(ev: WillAppearEvent<S>) {
		if (!ev.action.isKey() || ev.action.isInMultiAction()) return;
		const c = ev.action.coordinates;
		if (!c) return;
		const cols = ev.action.device.size?.columns || 4;
		const index = c.row * cols + c.column;
		this.slots.set(ev.action.id, index);
		const a = ev.action;
		this.engine.addKey({ id: a.id, setImage: (i) => a.setImage(i), setTitle: (t) => a.setTitle(t), showAlert: () => a.showAlert(), showOk: () => a.showOk() }, index);
	}
	override onWillDisappear(ev: WillDisappearEvent<S>) { this.engine.removeKey(ev.action.id); this.slots.delete(ev.action.id); }
	override onKeyDown(ev: KeyDownEvent<S>) { const i = this.slots.get(ev.action.id); if (i !== undefined) this.engine.keyDown(i); }
	override onKeyUp(ev: KeyUpEvent<S>) { const i = this.slots.get(ev.action.id); if (i !== undefined) this.engine.keyUp(i); }
}

/** One instance per dial (Stream Deck +). Draws its whole touch-strip segment. */
@action({ UUID: "com.var.contextdeck.dial" })
export class ContextDial extends SingletonAction<S> {
	private slots = new Map<string, number>();
	constructor(private engine: Engine) { super(); }

	override onWillAppear(ev: WillAppearEvent<S>) {
		if (!ev.action.isDial()) return;
		const index = ev.action.coordinates.column;
		this.slots.set(ev.action.id, index);
		const a = ev.action;
		this.engine.addDial({
			id: a.id,
			setFeedback: (f) => a.setFeedback(f as never),
			setTriggerDescription: (d) => a.setTriggerDescription(d),
			showAlert: () => a.showAlert(),
		}, index);
	}
	override onWillDisappear(ev: WillDisappearEvent<S>) { this.engine.removeDial(ev.action.id); this.slots.delete(ev.action.id); }
	override onDialRotate(ev: DialRotateEvent<S>) { const i = this.slots.get(ev.action.id); if (i !== undefined) void this.engine.dialRotate(i, ev.payload.ticks); }
	override onDialDown(ev: DialDownEvent<S>) { const i = this.slots.get(ev.action.id); if (i !== undefined) this.engine.dialPress(i); }
	override onTouchTap(ev: TouchTapEvent<S>) { const i = this.slots.get(ev.action.id); if (i !== undefined) this.engine.dialTouch(i, ev.payload.hold, ev.payload.tapPos?.[0]); }
}
