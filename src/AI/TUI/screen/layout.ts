import * as blessed from 'blessed';

/**
 * Vertical layout math for the chat TUI:
 *
 *   row 0          : status bar (1 line)
 *   rows 1..S      : transcript pane
 *   row  S+1       : (implicit splitter, the row between transcript and prompt)
 *   rows S+2..H-2  : prompt pane
 *   row H-1        : footer (1 line)
 *
 * The splitter row is the bottom-border row of the transcript box (so mouse
 * drag on that row lets the user resize). We expose a controller that holds
 * the prompt height in lines and emits change events.
 */

export interface LayoutConfig {
    /** Lines reserved for the prompt pane (including its borders). Min 5, Max ~ screen.height-6. */
    promptHeight: number;
    /** When true, the prompt pane is hidden and the transcript fills the screen. */
    promptHidden: boolean;
}

export interface LayoutController {
    config: () => LayoutConfig;
    /** Set absolute prompt height (clamped). Returns the applied height. */
    setPromptHeight: (lines: number) => number;
    /** Adjust prompt height by delta (negative => transcript bigger). */
    adjustPromptHeight: (delta: number) => number;
    /** Show/hide the prompt pane entirely (transcript expands when hidden). */
    setPromptHidden: (hidden: boolean) => void;
    /** Toggle prompt visibility; returns the new hidden state. */
    togglePromptHidden: () => boolean;
    /** Subscribe to layout changes; returns unsubscribe. */
    onChange: (fn: (cfg: LayoutConfig) => void) => () => void;
}

export interface CreateLayoutOptions {
    screen: blessed.Widgets.Screen;
    initialPromptHeight?: number;
    minPromptHeight?: number;
    minTranscriptHeight?: number;
}

export function createLayoutController(opts: CreateLayoutOptions): LayoutController {
    const screen = opts.screen;
    const minPrompt = opts.minPromptHeight ?? 5;
    const minTranscript = opts.minTranscriptHeight ?? 6;

    let cfg: LayoutConfig = { promptHeight: opts.initialPromptHeight ?? 8, promptHidden: false };
    const subs = new Set<(c: LayoutConfig) => void>();

    const screenH = (): number => {
        const h = (screen as unknown as { height: number }).height;

        return typeof h === 'number' ? h : 24;
    };

    const clamp = (n: number): number => {
        const max = Math.max(minPrompt, screenH() - 1 /* status */ - 1 /* footer */ - minTranscript);

        return Math.max(minPrompt, Math.min(max, Math.floor(n)));
    };

    const emit = (): void => {
        for (const fn of subs) fn(cfg);
    };

    return {
        config: () => ({ ...cfg }),
        setPromptHeight: (lines) => {
            const next = clamp(lines);
            if (next !== cfg.promptHeight) {
                cfg = { ...cfg, promptHeight: next };
                emit();
            }

            return cfg.promptHeight;
        },
        adjustPromptHeight: (delta) => {
            const next = clamp(cfg.promptHeight + delta);
            if (next !== cfg.promptHeight) {
                cfg = { ...cfg, promptHeight: next };
                emit();
            }

            return cfg.promptHeight;
        },
        setPromptHidden: (hidden) => {
            if (hidden === cfg.promptHidden) return;
            cfg = { ...cfg, promptHidden: hidden };
            emit();
        },
        togglePromptHidden: () => {
            cfg = { ...cfg, promptHidden: !cfg.promptHidden };
            emit();

            return cfg.promptHidden;
        },
        onChange: (fn) => {
            subs.add(fn);

            return () => { subs.delete(fn); };
        },
    };
}

/**
 * Wires a transcript+prompt pair to a LayoutController so they reposition
 * whenever the controller changes (or the screen resizes), and lets the user
 * drag the splitter row with the mouse to resize.
 */
export interface AttachLayoutOptions {
    screen: blessed.Widgets.Screen;
    transcript: blessed.Widgets.BoxElement;
    prompt: blessed.Widgets.BoxElement;
    /** Total chrome lines reserved at top (status bar = 1) and bottom (footer = 1). */
    topChrome?: number;
    bottomChrome?: number;
    controller: LayoutController;
    onLayout?: () => void;
}

export function attachLayout(opts: AttachLayoutOptions): void {
    const top = opts.topChrome ?? 1;
    const bottom = opts.bottomChrome ?? 1;
    const { screen, transcript, prompt, controller } = opts;

    const apply = (): void => {
        const config = controller.config();
        const promptH = config.promptHeight;
        const hidden = config.promptHidden;

        transcript.top = top;
        transcript.left = 0;
        transcript.width = '100%';
        // When the prompt is hidden the transcript fills everything between
        // the top status bar and the bottom footer; otherwise it sits above
        // the prompt pane.
        transcript.height = hidden
            ? `100%-${top + bottom}`
            : `100%-${top + bottom + promptH}`;

        // Anchor prompt to the bottom; clear any stale `top` from creation so
        // blessed doesn't position it under the status bar (which would make
        // it overlap the transcript).
        (prompt as unknown as { position: { top?: number | string | null } }).position.top = null;
        prompt.left = 0;
        prompt.width = '100%';
        prompt.height = promptH;
        prompt.bottom = bottom;
        // blessed honours `.hidden` on the next render.
        (prompt as unknown as { hidden: boolean }).hidden = hidden;

        if (opts.onLayout) opts.onLayout();
        screen.render();
    };

    apply();
    controller.onChange(apply);
    screen.on('resize', apply);

    // Mouse-drag splitter: the splitter row is the bottom border of the
    // transcript box. We listen for mousedown on that row and track motion.
    let dragging = false;
    let dragStartY = 0;
    let dragStartPromptH = 0;

    const splitterRow = (): number => {
        // top + transcript.height = bottom border row of transcript.
        const h = (screen as unknown as { height: number }).height;
        const promptH = controller.config().promptHeight;

        return h - bottom - promptH - 1;
    };

    screen.on('mouse', (data: { x?: number; y?: number; action?: string; button?: string }) => {
        if (typeof data.y !== 'number') return;
        const action = data.action;
        if (action === 'mousedown' && data.y === splitterRow()) {
            dragging = true;
            dragStartY = data.y;
            dragStartPromptH = controller.config().promptHeight;

            return;
        }
        if (dragging && (action === 'mousemove' || action === 'mousedown')) {
            const delta = dragStartY - data.y; // dragging up shrinks transcript / grows prompt
            controller.setPromptHeight(dragStartPromptH + delta);
        }
        if (action === 'mouseup') {
            dragging = false;
        }
    });
}
