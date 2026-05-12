/**
 * Real popup for indexing progress. Mounted by the AgentHost when the
 * indexing flow opens; closed when the flow signals "done". Lives on top
 * of the TUI as a centered blessed box with a title bar, a scrollable
 * log area, and a status footer. The user can dismiss it with Esc/q
 * after `done()` has been called.
 *
 *   ┌─ Indexing repo · alias ─────────────────────────────┐
 *   │  > scanned 12/142  src/foo/bar.ts                   │
 *   │  > scanned 13/142  src/foo/baz.ts                   │
 *   │  ...                                                │
 *   │─────────────────────────────────────────────────────│
 *   │  status / summary                          Esc · q  │
 *   └─────────────────────────────────────────────────────┘
 */

import * as blessed from 'blessed';
import { markOverlay } from '../state/popupRegistry';
import { BG_PRIMARY, BG_PANEL, BORDER_DIM } from '../theme';

export interface IndexProgressModal {
	/** Append a line to the scrollable log area (auto-scrolls). */
	append: (line: string) => void;
	/** Update the status / footer line shown under the log. */
	setStatus: (text: string) => void;
	/**
	 * Mark the indexing flow as complete and let the user dismiss the
	 * modal with Esc / q. Returns a promise that resolves once dismissed.
	 */
	finish: (summary?: string) => Promise<void>;
	/** Close immediately, regardless of completion. */
	close: () => void;
}

export interface ShowIndexProgressOptions {
	title: string;
	/** Optional initial body line. */
	initial?: string;
}

export function showIndexProgressModal(
	screen: blessed.Widgets.Screen,
	opts: ShowIndexProgressOptions,
): IndexProgressModal {
	const savedFocus = screen.focused;

	const box = blessed.box({
		parent: screen,
		top: 'center',
		left: 'center',
		width: '80%',
		height: '70%',
		border: { type: 'line' },
		style: {
			border: { fg: BORDER_DIM },
			bg: BG_PRIMARY,
			fg: 'white',
		},
		label: ` ${opts.title} `,
		keys: false,
	});

	const log = blessed.log({
		parent: box,
		top: 0,
		left: 0,
		right: 0,
		bottom: 2,
		scrollable: true,
		alwaysScroll: true,
		mouse: true,
		keys: true,
		vi: true,
		scrollbar: {
			ch: ' ',
			style: { bg: 'grey' },
		},
		tags: false,
		style: { bg: BG_PRIMARY, fg: 'white' },
	});
	// Mark only the outer box as the overlay; blessed already hides
	// children when the parent is hidden, and keeping the inner log /
	// statusLine / footer out of the registry means PopupRegistry's
	// "focus topmost" logic targets the modal as a whole and routes
	// focus to `log` via `getFocusTarget` below.
	markOverlay(box, { getFocusTarget: () => log });

	const statusLine = blessed.text({
		parent: box,
		bottom: 1,
		left: 1,
		right: 1,
		height: 1,
		content: 'indexing…',
		style: { bg: BG_PANEL, fg: 'yellow' },
	});

	const footer = blessed.text({
		parent: box,
		bottom: 0,
		left: 1,
		right: 1,
		height: 1,
		content: '  Esc / q to dismiss (after indexing completes)',
		style: { bg: BG_PANEL, fg: 'grey' },
	});

	if (opts.initial) log.add(opts.initial);

	log.focus();
	screen.render();

	let closed = false;
	let finishedResolve: (() => void) | null = null;
	let finished = false;

	const closeNow = (): void => {
		if (closed) return;
		closed = true;
		try { box.destroy(); } catch { /* ignore */ }
		try { savedFocus.focus(); } catch { /* ignore */ }
		screen.render();
		if (finishedResolve) {
			const r = finishedResolve;
			finishedResolve = null;
			r();
		}
	};

	log.key(['escape', 'q'], () => {
		// Only allow dismissal AFTER indexing completed. Before that,
		// pressing Esc is a no-op so the user can't accidentally hide
		// a flow they need to wait on.
		if (finished) closeNow();
	});

	return {
		append: (line) => {
			if (closed) return;
			log.add(line);
			screen.render();
		},
		setStatus: (text) => {
			if (closed) return;
			statusLine.setContent(text);
			screen.render();
		},
		finish: async (summary) => new Promise<void>((resolve) => {
			if (closed) {
				resolve();

				return;
			}
			finished = true;
			const finalText = summary ?? 'done · press Esc / q to dismiss';
			statusLine.setContent(finalText);
			(statusLine.style as { fg?: string }).fg = 'green';
			footer.setContent('  Esc / q to dismiss');
			screen.render();
			finishedResolve = resolve;
		}),
		close: closeNow,
	};
}

