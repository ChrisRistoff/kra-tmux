import * as blessed from 'blessed';

/**
 * Tracks every transient overlay (modal, popup, panel, spinner) attached
 * to the chat-TUI screen so the user can hide / show them all in one
 * keystroke (default: <space> t in NORMAL mode).
 *
 * Hidden overlays remain in the blessed tree — their key handlers and
 * focus state are restored exactly when shown again. Detached / destroyed
 * overlays are filtered out lazily.
 */
/**
 * Module-level mirror of `PopupRegistry`'s hidden state. Lives at module
 * scope so `markOverlay()` can consult it without needing a reference to
 * the registry instance — keeps widget construction zero-config.
 *
 * When true, freshly-created overlays start hidden too: they don't pop
 * up over a user who has explicitly chosen to hide popups. They become
 * visible the next time the user toggles popups back on.
 */
let globallyHidden = false;

/**
 * Marker property: any blessed element with `__kraOverlay === true` is
 * treated as a hide-able overlay by `PopupRegistry`. Set this when
 * creating a modal / panel / spinner — no explicit registration needed.
 *
 * If popups are currently globally hidden, the element is hidden
 * immediately so it doesn't flash visible for one frame.
 */
export interface OverlayOptions {
	/** Required when `pausedKeys` is set so we can re-pause on show. */
	screen?: blessed.Widgets.Screen;
	/**
	 * Screen-level keys this overlay wants suppressed while VISIBLE.
	 * When the overlay is hidden via the global hide toggle the keys are
	 * automatically restored, then re-paused on show. Without this, keys
	 * like `tab`/`escape` stay swallowed even though the popup is gone.
	 */
	pausedKeys?: string[];
	/**
	 * Optional resolver for the inner widget that should actually receive
	 * keyboard focus when the popup is (re-)focused via PopupRegistry.
	 * Use this for popups whose outer box wraps an inner interactive
	 * widget (textarea, list, …) that needs focus to function. Returning
	 * null falls back to focusing the marked element itself.
	 */
	getFocusTarget?: () => blessed.Widgets.BlessedElement | null;
	/**
	 * If false, this overlay is treated as purely decorative — it can be
	 * hidden / shown by the global toggle but is never picked as the
	 * focus target by `PopupRegistry.show()` / `maintainFocus()`. Set to
	 * false on non-interactive overlays (spinners, status badges, …)
	 * that would otherwise steal focus from a real modal underneath.
	 * Defaults to true.
	 */
	focusable?: boolean;
}

interface OverlayState {
	screen: blessed.Widgets.Screen | undefined;
	pausedKeys: string[] | undefined;
	/** Closure returned by the most recent pauseScreenKeys call. */
	currentRestore: (() => void) | null;
	getFocusTarget: (() => blessed.Widgets.BlessedElement | null) | undefined;
	focusable: boolean;
}

export interface OverlayHandle {
	/** Restore screen keys (if paused) and clear overlay markers. Idempotent. */
	release(): void;
}

import { pauseScreenKeys } from '@/UI/dashboard/screen';

export function markOverlay(
	el: blessed.Widgets.BlessedElement,
	opts?: OverlayOptions,
): OverlayHandle {
	(el as unknown as { __kraOverlay?: boolean }).__kraOverlay = true;

	const state: OverlayState = {
		screen: opts?.screen,
		pausedKeys: opts?.pausedKeys && opts.pausedKeys.length > 0 ? opts.pausedKeys : undefined,
		currentRestore: null,
		getFocusTarget: opts?.getFocusTarget,
		focusable: opts?.focusable !== false,
	};
	if (state.screen && state.pausedKeys) {
		state.currentRestore = pauseScreenKeys(state.screen, state.pausedKeys);
	}
	(el as unknown as { __kraOverlayState?: OverlayState }).__kraOverlayState = state;

	if (globallyHidden) {
		(el as unknown as { __kraHidden?: boolean }).__kraHidden = true;
		try { el.hide(); } catch { /* ignore */ }
		// Honour user's hide intent: don't keep keys suppressed for an invisible overlay.
		if (state.currentRestore) {
			try { state.currentRestore(); } catch { /* ignore */ }
			state.currentRestore = null;
		}
	}

	return {
		release: () => {
			if (state.currentRestore) {
				try { state.currentRestore(); } catch { /* ignore */ }
				state.currentRestore = null;
			}
			(el as unknown as { __kraOverlay?: boolean }).__kraOverlay = false;
			(el as unknown as { __kraOverlayState?: OverlayState | null }).__kraOverlayState = null;
		},
	};
}

export class PopupRegistry {
	private hidden = false;
	private lastFocus: blessed.Widgets.BlessedElement | null = null;

	/**
	 * @param screen          The screen to scan for overlays.
	 * @param getDefaultFocus Returns the element that should receive focus
	 *                        when overlays are hidden — typically the prompt
	 *                        pane so the user can navigate transcript/chat.
	 */
	constructor(
		private screen: blessed.Widgets.Screen,
		private getDefaultFocus: () => blessed.Widgets.BlessedElement | null = () => null,
	) { }

	isHidden(): boolean { return this.hidden; }


	private setGlobalFlag(v: boolean): void {
		this.hidden = v;
		globallyHidden = v;
	}

	toggle(): void {
		if (this.hidden) this.show();
		else this.hide();
	}

	hide(): void {
		if (this.hidden) return;
		this.setGlobalFlag(true);
		const overlays = this.findOverlays();
		// Remember whichever element currently has focus so we can return
		// to it on un-hide. Most often this is one of the overlays itself.
		this.lastFocus = this.screen.focused ?? null;
		for (const el of overlays) {
			(el as unknown as { __kraHidden?: boolean }).__kraHidden = true;
			try { el.hide(); } catch { /* ignore */ }
			// Restore any screen keys this overlay had paused — otherwise
			// tab/escape stay swallowed and the user can't navigate the
			// background as if the popup weren't there.
			const st = (el as unknown as { __kraOverlayState?: OverlayState | null }).__kraOverlayState;
			if (st?.currentRestore) {
				try { st.currentRestore(); } catch { /* ignore */ }
				st.currentRestore = null;
			}
		}
		// Intentionally do NOT move focus on hide. The user explicitly
		// toggled popups off; we leave focus exactly where it was. Background
		// panes (transcript / prompt) are still reachable via Tab and the
		// focus ring — we just don't pre-empt the user's choice.
		void this.getDefaultFocus;
		this.screen.render();
	}

	show(): void {
		if (!this.hidden) return;
		this.setGlobalFlag(false);
		const overlays = this.findOverlays();
		for (const el of overlays) {
			(el as unknown as { __kraHidden?: boolean }).__kraHidden = false;
			try { el.show(); } catch { /* ignore */ }
			try { el.setFront(); } catch { /* ignore */ }
			// Re-pause this overlay's screen keys now that it's visible again.
			const st = (el as unknown as { __kraOverlayState?: OverlayState | null }).__kraOverlayState;
			if (st && st.screen && st.pausedKeys && !st.currentRestore) {
				st.currentRestore = pauseScreenKeys(st.screen, st.pausedKeys);
			}
		}
		// Focus rule: when popups are un-hidden via the global toggle, the
		// topmost overlay ALWAYS gets focus. This is the user's escape hatch
		// when focus has drifted off a modal (e.g. an accidental mouse click
		// on the transcript while the "Custom answer" popup is open):
		// pressing <leader>t twice must reliably return focus to the popup.
		//
		// We only fall back to lastFocus when there is no overlay at all
		// (defensive — show() is normally a no-op in that case).
		// `findOverlays` walks depth-first; the last entry is the most
		// recently added (topmost) overlay. Inner-widget focus (e.g.
		// textarea inside a modal box) is preserved by the popup's own
		// `box.on('focus', () => pane.focus())` delegator.
		// Skip non-focusable overlays (spinners etc.) when picking the
		// topmost focus target — otherwise a decorative overlay added
		// after a real modal would steal its focus on every show().
		const focusable = overlays.filter((el) => this.isOverlayFocusable(el));
		const topmost = focusable.length > 0 ? focusable[focusable.length - 1] : null;
		const target = topmost
			?? (this.lastFocus && !this.isDetached(this.lastFocus) ? this.lastFocus : null);
		const focusTarget = (): void => {
			if (!target) return;
			try { target.setFront(); } catch { /* ignore */ }
			const inner = this.resolveInnerFocus(target);
			try { (inner ?? target).focus(); } catch { /* ignore */ }
		};
		focusTarget();
		// Re-focus on the next tick so we win against any focus change blessed
		// performs while processing the toggle keystroke itself.
		setImmediate(() => {
			if (this.hidden) return;
			focusTarget();
			this.screen.render();
		});
		this.screen.render();
	}

	/**
	 * Re-focus the topmost visible overlay if focus has drifted off it
	 * (e.g. user mouse-clicked the transcript while a modal is open).
	 * No-op when popups are hidden, when there are no visible overlays,
	 * or when focus is already inside one.
	 */
	maintainFocus(): void {
		if (this.hidden) return;
		const overlays = this.findOverlays();
		if (overlays.length === 0) return;
		const focused = this.screen.focused as blessed.Widgets.BlessedElement | undefined;
		// Already inside any overlay (focusable or not) — leave alone so
		// the user can intentionally interact with non-modal overlays.
		if (focused && this.isInsideAnyOverlay(focused, overlays)) return;
		const focusable = overlays.filter((el) => this.isOverlayFocusable(el));
		if (focusable.length === 0) return;
		const topmost = focusable[focusable.length - 1];
		try { topmost.setFront(); } catch { /* ignore */ }
		const inner = this.resolveInnerFocus(topmost);
		try { (inner ?? topmost).focus(); } catch { /* ignore */ }
		this.screen.render();
	}

	private isOverlayFocusable(el: blessed.Widgets.BlessedElement): boolean {
		const st = (el as unknown as { __kraOverlayState?: OverlayState | null }).__kraOverlayState;
		return !st || st.focusable !== false;
	}

	/**
	 * If the overlay registered a `getFocusTarget` resolver, return whatever
	 * inner widget it points at (when still alive). Otherwise null — callers
	 * fall back to focusing the marked overlay element itself.
	 */
	private resolveInnerFocus(
		el: blessed.Widgets.BlessedElement,
	): blessed.Widgets.BlessedElement | null {
		const st = (el as unknown as { __kraOverlayState?: OverlayState | null }).__kraOverlayState;
		if (!st?.getFocusTarget) return null;
		try {
			const inner = st.getFocusTarget();
			if (inner && !this.isDetached(inner)) return inner;
		} catch { /* ignore */ }
		return null;
	}

	private isInsideAnyOverlay(
		el: blessed.Widgets.BlessedElement,
		overlays: blessed.Widgets.BlessedElement[],
	): boolean {
		let cur: unknown = el;
		while (cur) {
			if (overlays.includes(cur as blessed.Widgets.BlessedElement)) return true;
			cur = (cur as { parent?: unknown }).parent;
		}
		return false;
	}

	private findOverlays(): blessed.Widgets.BlessedElement[] {
		const out: blessed.Widgets.BlessedElement[] = [];
		const walk = (node: unknown): void => {
			const n = node as { children?: unknown[], __kraOverlay?: boolean };
			if (n && n.__kraOverlay && !this.isDetached(n as blessed.Widgets.BlessedElement)) {
				out.push(n as blessed.Widgets.BlessedElement);
			}
			if (n && Array.isArray(n.children)) {
				for (const c of n.children) walk(c);
			}
		};
		walk(this.screen);

		return out;
	}

	private isDetached(el: blessed.Widgets.BlessedElement): boolean {
		const any = el as unknown as { detached?: boolean, parent?: unknown };
		return !!any.detached || !any.parent;
	}
}

