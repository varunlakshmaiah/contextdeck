/**
 * Swipe-to-page. The Stream Deck app keeps the touch-strip swipe for itself: it flips the *profile's* pages and
 * never tells plugins. So the bundled ContextDeck profile has several identical Stream Deck pages, each action
 * knowing its page number (settings.sdPage). When a different page appears, we know which way you swiped,
 * turn ContextDeck's page, and jump back to the middle page so the next swipe works in either direction.
 */
export const MIDDLE_PAGE = 2;

export class SwipePages {
	private last = new Map<string, number>();
	private expectJump = new Map<string, number>();  // device -> until (ms): our own recentre, not a swipe
	constructor(
		private turn: (dir: "next" | "prev", device: string) => void,
		private recentre: (device: string) => Promise<void> | void,
		private now: () => number = Date.now,
	) {}

	/** Called for every action that appears; only the first one of a new page matters. */
	appeared(device: string, sdPage: unknown) {
		if (typeof sdPage !== "number") return;
		const prev = this.last.get(device);
		if (prev === sdPage) return;
		this.last.set(device, sdPage);
		if (prev === undefined) return;                                      // profile just opened
		if ((this.expectJump.get(device) ?? 0) > this.now()) { this.expectJump.delete(device); return; }
		this.turn(sdPage > prev ? "next" : "prev", device);
		if (sdPage !== MIDDLE_PAGE) {
			this.expectJump.set(device, this.now() + 1500);
			void Promise.resolve(this.recentre(device)).catch(() => this.expectJump.delete(device));
		}
	}
}
