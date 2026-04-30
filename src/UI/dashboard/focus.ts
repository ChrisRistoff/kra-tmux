import * as blessed from 'blessed';

export interface FocusPanel {
    el: blessed.Widgets.BlessedElement;
    name: string;
    color: string;
}

export interface FocusRing {
    focusAt: (idx: number) => void;
    next: () => void;
    prev: () => void;
    idx: () => number;
    current: () => FocusPanel;
    panels: () => readonly FocusPanel[];
    chips: () => string;
    renderFooter: () => void;
}

export interface FocusRingOptions {
    screen: blessed.Widgets.Screen;
    panels: FocusPanel[];
    footer: blessed.Widgets.BoxElement;
    /** Static or dynamic keymap content appended after the focus chips. */
    keymapText: string | (() => string);
    /** Optional callback fired after focus changes (e.g. to re-render side panels). */
    onChange?: (idx: number) => void;
}

export function setBorder(el: blessed.Widgets.BlessedElement, fg: string): void {
    const s = el.style as { border?: { fg?: string } };
    if (!s.border) s.border = {};
    s.border.fg = fg;
}

export function createFocusRing(opts: FocusRingOptions): FocusRing {
    const { screen, panels, footer, keymapText, onChange } = opts;
    let focusIdx = 0;

    const chips = (): string =>
        panels
            .map((p, i) => {
                if (i === focusIdx) {
                    return `{black-fg}{${p.color}-bg} ${p.name} {/${p.color}-bg}{/black-fg}`;
                }

                return `{gray-fg} ${p.name} {/gray-fg}`;
            })
            .join(' ');

    const renderFooter = (): void => {
        const km = typeof keymapText === 'function' ? keymapText() : keymapText;
        footer.setContent(` ${chips()}   ${km}`);
    };

    const focusAt = (i: number): void => {
        const prev = panels[focusIdx];
        setBorder(prev.el, prev.color);
        focusIdx = ((i % panels.length) + panels.length) % panels.length;
        const next = panels[focusIdx];
        setBorder(next.el, 'white');
        next.el.focus();
        renderFooter();
        if (onChange) onChange(focusIdx);
        screen.render();
    };

    return {
        focusAt,
        next: () => focusAt(focusIdx + 1),
        prev: () => focusAt(focusIdx - 1),
        idx: () => focusIdx,
        current: () => panels[focusIdx],
        panels: () => panels,
        chips,
        renderFooter,
    };
}

/**
 * Wires `tab` / `S-tab` to cycle through the focus ring at the screen level.
 */
export function attachFocusCycleKeys(screen: blessed.Widgets.Screen, ring: FocusRing): void {
    screen.key(['tab'], () => ring.next());
    screen.key(['S-tab'], () => ring.prev());
}
