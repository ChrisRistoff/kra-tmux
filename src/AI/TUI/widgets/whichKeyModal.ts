import * as blessed from 'blessed';
import { pauseScreenKeys } from '@/UI/dashboard/screen';
import { BG_PRIMARY } from '../theme';

export interface WhichKeyItem {
    key: string;
    label: string;
    description?: string;
    /**
     * Optional grouping. Items sharing a category render together under
     * a section header in the modal. Items without a category fall into
     * a trailing "Other" section. Category order in the modal matches
     * the order categories first appear in the items array.
     */
    category?: string;
    action: () => void;
}

/**
 * Which-key style popup. Press the leader key (Space) to open; the
 * modal lists every available follow-up key. Press a listed hotkey to
 * fire its action immediately. Esc / q closes without firing.
 */
let leaderOpen = false;

/** Returns true if a which-key/leader popup is currently visible. */
export function isLeaderOpen(): boolean { return leaderOpen; }

export function showWhichKey(
    screen: blessed.Widgets.Screen,
    items: WhichKeyItem[],
    opts: { title?: string } = {},
): Promise<void> {
    if (leaderOpen) return Promise.resolve();
    leaderOpen = true;
    return new Promise((resolve) => {
        const savedFocus = screen.focused;
        const hotkeys = items.map((i) => i.key);
        const restoreKeys = pauseScreenKeys(
            screen,
            ['escape', 'q', 'C-c', ...hotkeys],
        );

        const labelMaxLen = items.reduce((m, i) => Math.max(m, i.label.length), 0);

        // Group items by category, preserving the order categories first
        // appear in the items array. Items without a category fall into a
        // trailing "Other" group.
        const groups: { name: string; items: WhichKeyItem[] }[] = [];
        const groupIndex = new Map<string, number>();
        for (const item of items) {
            const name = item.category ?? 'Other';
            let idx = groupIndex.get(name);
            if (idx === undefined) {
                idx = groups.length;
                groupIndex.set(name, idx);
                groups.push({ name, items: [] });
            }
            groups[idx].items.push(item);
        }

        const lines: string[] = [];
        groups.forEach((group, gi) => {
            if (gi > 0) lines.push('');
            lines.push(` {bold}{cyan-fg}━ ${escapeTags(group.name)} ━{/cyan-fg}{/bold}`);
            for (const i of group.items) {
                const key = padRight(`{magenta-fg}${escapeTags(i.key)}{/magenta-fg}`, 6);
                const label = padRight(escapeTags(i.label), labelMaxLen + 2);
                const desc = i.description
                    ? `  {gray-fg}${escapeTags(i.description)}{/gray-fg}`
                    : '';
                lines.push(`   ${key} →  ${label}${desc}`);
            }
        });
        lines.push('');
        lines.push(' {gray-fg}[Esc/q] cancel{/gray-fg}');

        // height = content lines + 2 borders
        const height = lines.length + 2;

        const box = blessed.box({
            parent: screen,
            label: ` ${opts.title ?? 'Leader'} `,
            bottom: 1,
            left: 'center',
            width: '70%',
            height,
            border: { type: 'line' },
            style: { border: { fg: 'magenta' }, bg: BG_PRIMARY },
            tags: true,
        });
        box.setFront();
        box.setContent(lines.join('\n'));

        const cleanup = (chosen: WhichKeyItem | null): void => {
            leaderOpen = false;
            box.destroy();
            restoreKeys();
            if (savedFocus) {
                try { savedFocus.focus(); } catch { /* ignore */ }
            }
            screen.render();
            if (chosen) chosen.action();
            resolve();
        };

        // Items with single ASCII letter keys may bind their opposite case
        // ONLY if no other item explicitly claims that case (otherwise the
        // lower-case binding would shadow upper-case items like `A`/`R`/`P`).
        const claimedKeys = new Set(items.map((i) => i.key));
        for (const item of items) {
            const isLetter = item.key.length === 1 && /[a-z]/i.test(item.key);
            const opposite = isLetter
                ? (item.key === item.key.toLowerCase()
                    ? item.key.toUpperCase()
                    : item.key.toLowerCase())
                : null;
            const variants = isLetter && opposite && !claimedKeys.has(opposite)
                ? [item.key, opposite]
                : [item.key];
            box.key(variants, () => cleanup(item));
        }
        box.key(['escape', 'q', 'C-c'], () => cleanup(null));

        box.focus();
        screen.render();
    });
}

function escapeTags(s: string): string {
    return s.replace(/[{}]/g, (c) => (c === '{' ? '{open}' : '{close}'));
}

// Pads using the visible length (ignoring blessed tags).
function padRight(s: string, width: number): string {
    const visible = s.replace(/\{[^}]+\}/g, '');
    const pad = Math.max(0, width - visible.length);

    return s + ' '.repeat(pad);
}
