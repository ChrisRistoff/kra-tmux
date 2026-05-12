/**
 * Tool-call history panel for the chat TUI. Toggle with Ctrl-H.
 *
 * Layout: split modal — left list (newest first) of past tool calls,
 * right detail pane (args + result). j/k or arrows to navigate, q/Esc
 * to close.
 */

import * as blessed from 'blessed';
import { markOverlay } from '../state/popupRegistry';
import { BG_PRIMARY, BG_PANEL, BORDER_DIM } from '../theme';
import type { ToolHistoryStore, ToolHistoryEntry } from '../state/toolHistory';

function fmtTime(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number): string => String(n).padStart(2, '0');
	return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtDuration(start: number, end?: number): string {
	if (!end) return ' ··· ';
	const ms = end - start;
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(2)}s`;
}

function statusBadge(status: ToolHistoryEntry['status']): string {
	if (status === 'running') return '{yellow-fg}\u25CF run{/yellow-fg}';
	if (status === 'ok') return '{green-fg}\u2713 ok{/green-fg}';
	return '{red-fg}\u2717 fail{/red-fg}';
}

function escapeTags(s: string): string {
	return s.replace(/[{}]/g, (c) => (c === '{' ? '{open}' : '{close}'));
}

export async function showToolHistoryPanel(
	screen: blessed.Widgets.Screen,
	store: ToolHistoryStore,
): Promise<void> {
	return new Promise((resolve) => {
		const savedFocus = screen.focused;

		const box = blessed.box({
			parent: screen,
			label: ' Tool-call history ',
			top: 'center',
			left: 'center',
			width: '90%',
			height: '85%',
			border: { type: 'line' },
			style: { border: { fg: BORDER_DIM }, bg: BG_PRIMARY },
			tags: true,
		});
		box.setFront();

		const list = blessed.list({
			parent: box,
			top: 0,
			left: 0,
			width: '40%',
			bottom: 2,
			keys: true,
			mouse: true,
			tags: true,
			scrollable: true,
			scrollbar: { ch: ' ', style: { bg: 'gray' } },
			style: {
				bg: BG_PRIMARY,
				item: { fg: 'white' },
				selected: { bg: 'cyan', fg: 'black', bold: true },
			},
			border: { type: 'line' },
		});

		const detail = blessed.box({
			parent: box,
			top: 0,
			right: 0,
			width: '60%',
			bottom: 2,
			tags: true,
			scrollable: true,
			alwaysScroll: true,
			keys: true,
			mouse: true,
			scrollbar: { ch: ' ', style: { bg: 'gray' } },
			style: { bg: BG_PRIMARY, fg: 'white' },
			border: { type: 'line' },
			content: '',
		});

		blessed.box({
			parent: box,
			bottom: 0,
			left: 1,
			right: 1,
			height: 2,
			tags: true,
			style: { bg: BG_PANEL },
			content:
				'{cyan-fg}[\u2191/\u2193 j/k]{/cyan-fg} navigate  ' +
				'{cyan-fg}[Tab]{/cyan-fg} switch focus  ' +
				'{cyan-fg}[c]{/cyan-fg} clear  ' +
				'{red-fg}[q/Esc]{/red-fg} close',
		});

		const renderList = (): void => {
			const entries = store.list().slice().reverse();
			if (entries.length === 0) {
				list.setItems(['{gray-fg}(no tool calls yet){/gray-fg}']);
				detail.setContent('{gray-fg}History is empty. Trigger a web_fetch / web_search etc. and it will show up here.{/gray-fg}');
				screen.render();
				return;
			}
			const items = entries.map((e) => {
				const status = statusBadge(e.status);
				return ` ${status} {bold}${escapeTags(e.toolName)}{/bold} {gray-fg}\u00b7 ${fmtTime(e.startedAt)}{/gray-fg}`;
			});
			list.setItems(items);
			const sel = (list as unknown as { selected?: number }).selected ?? 0;
			renderDetail(entries[sel]);
			screen.render();
		};

		const renderDetail = (entry: ToolHistoryEntry | undefined): void => {
			if (!entry) { detail.setContent(''); return; }
			const lines: string[] = [];
			lines.push(`{cyan-fg}Tool:{/cyan-fg} ${escapeTags(entry.toolName)}`);
			lines.push(`{cyan-fg}Status:{/cyan-fg} ${statusBadge(entry.status)}  {gray-fg}(${fmtDuration(entry.startedAt, entry.finishedAt)}){/gray-fg}`);
			lines.push(`{cyan-fg}Started:{/cyan-fg} ${fmtTime(entry.startedAt)}`);
			if (entry.finishedAt) lines.push(`{cyan-fg}Finished:{/cyan-fg} ${fmtTime(entry.finishedAt)}`);
			if (entry.summary) {
				lines.push('');
				lines.push('{gray-fg}── Summary ──────────────────────────{/gray-fg}');
				lines.push(escapeTags(entry.summary));
			}
			lines.push('');
			lines.push('{gray-fg}── Args ─────────────────────────────{/gray-fg}');
			lines.push(escapeTags(entry.argsJson));
			if (entry.result !== undefined) {
				lines.push('');
				lines.push(`{gray-fg}── Result ${entry.status === 'fail' ? '{red-fg}(failed){/red-fg}' : '{green-fg}(ok){/green-fg}'} ──────────────────────{/gray-fg}`);
				const truncated = entry.result.length > 8000
					? entry.result.slice(0, 8000) + `\n\n… (${entry.result.length - 8000} more chars)`
					: entry.result;
				lines.push(escapeTags(truncated));
			}
			detail.setContent(lines.join('\n'));
			detail.scrollTo(0);
		};

		const cleanup = (): void => {
			box.destroy();
			restoreKeys();
			if (savedFocus) {
				try { savedFocus.focus(); } catch { /* ignore */ }
			}
			screen.render();
			resolve();
		};

		list.on('select item', () => {
			const entries = store.list().slice().reverse();
			renderDetail(entries[(list as unknown as { selected?: number }).selected ?? 0]);
			screen.render();
		});

		list.key(['enter'], () => detail.focus());
		list.key(['tab'], () => detail.focus());
		detail.key(['tab'], () => list.focus());
		detail.key(['S-tab'], () => list.focus());

		// Track which pane (list vs detail) was last focused so that when
		// the popup is hidden + re-shown via the global toggle, focus goes
		// back to the right inner widget rather than the outer box.
		let lastInnerFocus: blessed.Widgets.BlessedElement = list;
		list.on('focus', () => { lastInnerFocus = list; });
		detail.on('focus', () => { lastInnerFocus = detail; });

		const overlay = markOverlay(box, {
			screen,
			pausedKeys: ['q', 'C-c', 'escape', 'tab', 'S-tab'],
			getFocusTarget: () => lastInnerFocus,
		});
		const restoreKeys = (): void => overlay.release();
		list.key(['c'], () => { store.clear(); renderList(); });
		list.key(['q', 'escape', 'C-c'], cleanup);
		detail.key(['q', 'escape', 'C-c'], cleanup);
		box.key(['q', 'escape', 'C-c'], cleanup);

		renderList();
		list.focus();
		screen.render();
	});
}

