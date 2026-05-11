/**
 * User-input modal for the AI Agent. Renders a question with optional
 * numbered choices and an optional freeform input field:
 *
 *   ┌─ Agent question ────────────────────────────────────┐
 *   │ <question text, may span multiple lines>            │
 *   │                                                     │
 *   │  ❯ [1] Yes                                          │
 *   │    [2] No                                           │
 *   │    [3] Custom answer …                              │
 *   │                                                     │
 *   │  Enter to pick · Esc to dismiss                     │
 *   └─────────────────────────────────────────────────────┘
 *
 * If `allowFreeform` is true (default), an extra "Custom answer …" row
 * opens a small textbox that returns the typed string. Numeric hotkeys
 * (1..9) jump straight to a choice. Esc / q resolves with `answer: ''`.
 */

import * as blessed from 'blessed';
import { markOverlay } from '../state/popupRegistry';
import { pauseScreenKeys } from '@/UI/dashboard/screen';
import { showFreeformInputModal } from './freeformInputModal';
import { BG_PRIMARY } from '../theme';

export interface UserInputResponse {
    answer: string;
    wasFreeform: boolean;
}

export interface UserInputOptions {
    question: string;
    choices?: string[];
    allowFreeform?: boolean;
    title?: string;
}

const FREEFORM_LABEL = 'Custom answer …';

export async function showUserInputModal(
    screen: blessed.Widgets.Screen,
    opts: UserInputOptions,
): Promise<UserInputResponse> {
    const choices = opts.choices ?? [];
    const allowFreeform = opts.allowFreeform !== false;
    const items: string[] = [...choices];
    const freeformIdx = allowFreeform ? items.length : -1;
    if (allowFreeform) items.push(FREEFORM_LABEL);

    return new Promise<UserInputResponse>((resolve) => {
        const savedFocus = screen.focused;
        const numericKeys = items.map((_, i) => String((i + 1) % 10));
        const restoreKeys = pauseScreenKeys(
            screen,
            ['escape', 'q', 'C-c', 'enter', 'up', 'down', 'k', 'j', ...numericKeys],
        );

        const questionLines = wrapLines(opts.question, 72);
        const itemLines = items.length;
        const height = Math.min(
            screen.height as number - 4,
            questionLines.length + 1 + itemLines + 2 + 2,
        );

        const box = blessed.box({
            parent: screen,
            label: ` ${opts.title ?? 'Agent question'} `,
            top: 'center',
            left: 'center',
            width: '70%',
            height,
            border: { type: 'line' },
            style: { border: { fg: 'cyan' }, bg: BG_PRIMARY },
            tags: true,
            keys: false,
            mouse: false,
        });
        const overlay = markOverlay(box);
        box.setFront();

        let selected = 0;

        const render = (): void => {
            const lines: string[] = [];
            for (const ql of questionLines) lines.push(escapeTags(ql));
            lines.push('');
            items.forEach((label, i) => {
                const cursor = i === selected ? '{cyan-fg}❯{/cyan-fg}' : ' ';
                const hotkey = `{magenta-fg}[${(i + 1) % 10 || 0}]{/magenta-fg}`;
                lines.push(`  ${cursor} ${hotkey} ${escapeTags(label)}`);
            });
            lines.push('');
            lines.push(' {gray-fg}↑/↓ to move · Enter to pick · Esc to dismiss{/gray-fg}');
            box.setContent(lines.join('\n'));
            screen.render();
        };

        const cleanup = (): void => {
            overlay.release();
            restoreKeys();
            box.destroy();
            if (savedFocus) {
                try { (savedFocus).focus(); } catch { /* ignore */ }
            }
            screen.render();
        };

        const finish = (resp: UserInputResponse): void => {
            cleanup();
            resolve(resp);
        };

        const promptFreeform = (): void => {
            // Use the shared multi-line modal (NORMAL/INSERT modes,
            // bigger box) instead of the old single-line textbox.
            void showFreeformInputModal(screen, {
                title: 'Custom answer',
                borderFg: 'yellow',
                hint: '{gray-fg}i=insert · esc=NORMAL · NORMAL+enter=submit · INSERT+enter=newline · C-c=cancel{/gray-fg}',
            }).then((val) => {
                finish({ answer: val ?? '', wasFreeform: true });
            });
        };

        box.key(['escape', 'q', 'C-c'], () => finish({ answer: '', wasFreeform: true }));
        box.key(['up', 'k'], () => { selected = (selected - 1 + items.length) % items.length; render(); });
        box.key(['down', 'j'], () => { selected = (selected + 1) % items.length; render(); });
        box.key('enter', () => {
            if (selected === freeformIdx) {
                box.hide();
                screen.render();
                promptFreeform();

                return;
            }
            const value = items[selected];
            finish({ answer: value, wasFreeform: false });
        });
        // Numeric hotkeys 1..9 (and 0 for the 10th slot)
        items.forEach((_, i) => {
            const key = String((i + 1) % 10);
            box.key(key, () => {
                if (i === freeformIdx) {
                    box.hide();
                    screen.render();
                    promptFreeform();

                    return;
                }
                finish({ answer: items[i], wasFreeform: false });
            });
        });

        if (items.length === 0 && allowFreeform) {
            // No choices, allowFreeform = true — jump straight to the textbox.
            box.hide();
            screen.render();
            promptFreeform();

            return;
        }

        box.focus();
        render();
    });
}

function escapeTags(s: string): string {
    return s.replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}

function wrapLines(text: string, width: number): string[] {
    const lines: string[] = [];
    for (const raw of text.split('\n')) {
        if (raw.length <= width) {
            lines.push(raw);
            continue;
        }
        let rest = raw;
        while (rest.length > width) {
            const breakAt = rest.lastIndexOf(' ', width);
            const at = breakAt > 20 ? breakAt : width;
            lines.push(rest.slice(0, at));
            rest = rest.slice(at).trimStart();
        }
        if (rest) lines.push(rest);
    }

    return lines;
}
