import * as blessed from 'blessed';
import {
    createDashboardScreen,
    createFocusRing,
    attachFocusCycleKeys,
    setBorder,
    type FocusRing,
} from '@/UI/dashboard';
import { BG_PANEL, BG_PRIMARY, FG_BODY, FG_MUTED, THEME_HEXES } from './theme';
import { installTruecolorPatch, registerTruecolorHexes, setDefaultThemeRgb } from './screen/truecolorPatch';
import { createRenderScheduler, type RenderScheduler } from './screen/renderScheduler';
import { createLayoutController, attachLayout, type LayoutController } from './screen/layout';
import { createStatusBar, type StatusBar, type TuiMode } from './widgets/statusBar';
import { createTranscriptPane, type TranscriptPane } from './widgets/transcriptPane';
import { createPromptPane, type PromptPane } from './widgets/promptPane';
import { createStreamMarkdownRenderer, type StreamMarkdownRenderer } from './markdown/streamRenderer';
import { ToolHistoryStore } from './state/toolHistory';
import { PopupRegistry } from './state/popupRegistry';
import { ToolSpinnerWidget } from './widgets/toolSpinner';

export interface ChatTuiOptions {
    title: string;
    model: string;
    /** Called when the user submits a prompt. (Stage 1 stub: Ctrl-Enter from textarea.) */
    onSubmit?: (prompt: string) => void;
    /** Called once when the screen is destroyed (cleanup). */
    onExit?: () => void;
    /**
     * Optional output stream for blessed renders. Set when the caller has
     * called `installConsoleRedirect()` and needs blessed to keep drawing
     * to the real TTY despite raw `process.stdout.write` being silenced.
     */
    output?: NodeJS.WritableStream;
}

export interface ChatTuiApp {
    screen: blessed.Widgets.Screen;
    transcript: TranscriptPane;
    prompt: PromptPane;
    status: StatusBar;
    layout: LayoutController;
    focus: FocusRing;
    scheduler: RenderScheduler;
    /** Append text to the transcript pane and schedule a coalesced render. */
    appendTranscript: (text: string) => void;
    /** Feed a chunk of markdown into the stream renderer; finalized lines are
     *  styled with ANSI and tail line is updated provisionally. */
    appendMarkdown: (text: string) => void;
    /** Force-flush any in-progress markdown tail as a finalized line. */
    flushMarkdown: () => void;
    /** Reset the markdown stream state (for a new message). */
    resetMarkdown: () => void;
    markdown: StreamMarkdownRenderer;
    /** In-memory ring buffer of tool-call lifecycle events (␣ h opens viewer). */
    toolHistory: ToolHistoryStore;
    /** Registry of all transient overlays — used by the ␣ t hide/show toggle. */
    popups: PopupRegistry;
    /** Top-right floating spinner panel for in-flight tool calls. */
    spinner: ToolSpinnerWidget;
    /** Update status bar fields. */
    setStatus: (patch: Parameters<StatusBar['set']>[0]) => void;
    /** Destroy the screen and resolve `done()`. */
    quit: () => void;
    /** Resolves when the screen is destroyed. */
    done: () => Promise<void>;
}

export function createChatTuiApp(opts: ChatTuiOptions): ChatTuiApp {
    // Must run before any blessed.Screen / Program is constructed: it
    // patches `Program.prototype._owrite` to rewrite our themed 256-
    // palette emissions as 24-bit truecolor SGR.
    registerTruecolorHexes(THEME_HEXES);
    setDefaultThemeRgb(BG_PRIMARY, FG_BODY);
    installTruecolorPatch();

    let exited = false;
    const onExit = (): void => {
        if (exited) return;
        exited = true;
        if (opts.onExit) {
            try { opts.onExit(); } catch { /* ignore */ }
        }
    };

    const screen = createDashboardScreen({
        title: opts.title,
        onQuit: onExit,
        // Conversation TUI: C-q is the ONLY quit key. `q` is left free
        // so it acts like Esc inside modals (which already bind it),
        // and C-c is reserved for stop-stream wired by chat/agent.
        quitKeys: ['C-q'],
        ...(opts.output ? { output: opts.output } : {}),
    });
    (screen as unknown as { useBuf?: boolean }).useBuf = true;

    // -------------------------------------------------------------
    // Mouse: wheel-only.
    //
    // blessed's default `enableMouse()` turns on cellMotion + allMotion
    // (DEC modes 1002/1003) which sends an event for every cursor cell
    // crossed. Inside tmux that wrecks our popups: focus stops responding
    // to keys the moment the mouse twitches over a modal, and the cursor
    // disappears. We also want native terminal text selection to keep
    // working when the user just moves/clicks.
    //
    // Solution: enable ONLY vt200Mouse (DEC 1000) which reports button
    // press/release — critically, that includes the scroll wheel. No
    // motion is reported, so popups behave normally and Option-drag /
    // shift-drag native selection still works. We then permanently
    // override `enableMouse` so any later widget creation cannot upgrade
    // us back to motion-tracking mode.
    // -------------------------------------------------------------
    try {
        type ProgramLike = {
            enableMouse?: () => void;
            disableMouse?: () => void;
            setMouse?: (opt: Record<string, boolean>, enable: boolean) => void;
        };
        const program = (screen as unknown as { program?: ProgramLike }).program;
        if (program) {
            const wheelOnly = (): void => {
                try { program.disableMouse?.(); } catch { /* ignore */ }
                try { program.setMouse?.({ vt200Mouse: true }, true); } catch { /* ignore */ }
            };
            wheelOnly();
            program.enableMouse = wheelOnly;
        }
    } catch { /* ignore */ }


    // NOTE: deliberately do NOT override `screen.dattr`. blessed's draw
    // loop short-circuits SGR emission whenever a cell's attr equals
    // `screen.dattr`. If we set dattr to BG_PRIMARY's palette index,
    // every transcript/prompt cell (which has `bg: BG_PRIMARY`) would
    // match dattr and emit nothing — leaving the area painted with the
    // terminal default (black) and bypassing our truecolor rewriter.
    // Keep dattr at blessed's default so element bgs always emit an
    // explicit SGR that the rewriter can convert to themed RGB.

    const layout = createLayoutController({ screen, initialPromptHeight: 8 });
    // 240 fps to match the pacer (~240 cps default) so each rendered frame
    // paints exactly one new glyph — that's what gives the smooth typewriter
    // feel without bursts. blessed's render is cheap enough to handle this
    // for streaming text; we still coalesce dirty marks so idle = 0 cost.
    const scheduler = createRenderScheduler(screen, { fps: 240 });
    type WidthRef = { viewportWidth: () => number };
    let transcriptRef: WidthRef | null = null;
    const mdRenderer = createStreamMarkdownRenderer({
        getViewportWidth: () => {
            const r: WidthRef | null = transcriptRef;

            return r ? r.viewportWidth() : 120;
        },
    });
    const toolHistory = new ToolHistoryStore();
    // Default focus target when popups are hidden: the transcript pane,
    // so the user can scroll/yank chat history. We focus through the
    // focusRing (declared further down) once it exists; until then we
    // fall back to the prompt — the registry isn't usable before mount.
    let focusTranscript: (() => void) | null = null;
    const popups = new PopupRegistry(screen, () => {
        if (focusTranscript) { focusTranscript();

 return null; }

        return prompt.el;
    });
    const spinner = new ToolSpinnerWidget(screen);

    // Drain a batch of RenderedLines into the transcript, honoring the
    // optional `replacesPrevious` flag (used by code-fence closure to
    // swap the N provisional dim rows for highlighted ones in place).
    const consumeRenderedLines = (
        batch: { plain: string; styled: string; replacesPrevious?: number; wrapStyled?: boolean }[],
    ): void => {
        let i = 0;
        while (i < batch.length) {
            const head = batch[i];
            if (head.replacesPrevious && head.replacesPrevious > 0) {
                // Group the contiguous replacement run: head plus any
                // following lines until the next replacesPrevious marker
                // or end of batch. (In practice the whole code-fence
                // batch is contiguous and starts at index i.)
                let j = i + 1;
                while (j < batch.length && !batch[j].replacesPrevious) j++;
                transcript.replaceLastLines(
                    head.replacesPrevious,
                    batch.slice(i, j).map((l) => (
                        l.wrapStyled
                            ? { plain: l.plain, styled: l.styled, wrapStyled: true as const }
                            : { plain: l.plain, styled: l.styled }
                    )),
                );
                i = j;
            } else {
                transcript.append(head.plain + '\n');
                if (head.styled) {
                    transcript.setLineStyled(transcript.lineCount() - 2, head.styled, head.wrapStyled);
                }
                i++;
            }
        }
    };

    const status = createStatusBar(screen, {
        mode: 'NORMAL',
        pane: 'transcript',
        model: opts.model,
        streaming: false,
        title: opts.title,
    });

    const transcript = createTranscriptPane({
        parent: screen,
        top: 1,
        height: 1, // overwritten by attachLayout
        onChange: () => scheduler.schedule(),
        onModeChange: (m) => {
            if (focus.idx() !== 0) return;
            status.set({ mode: m });
            scheduler.schedule();
        },
        onYank: (n) => {
            status.set({ extra: `yanked ${n} char${n === 1 ? '' : 's'}` });
            scheduler.schedule();
            setTimeout(() => { status.set({ extra: '' }); scheduler.schedule(); }, 1200);
        },
    });
    transcriptRef = transcript;

    const prompt = createPromptPane({
        parent: screen,
        top: 1,
        height: 1, // overwritten by attachLayout
        onChange: () => scheduler.schedule(),
        onModeChange: (m) => {
            if (focus.idx() !== 1) return;
            status.set({ mode: m });
            scheduler.schedule();
        },
        onYank: (n) => {
            status.set({ extra: `yanked ${n} char${n === 1 ? '' : 's'}` });
            scheduler.schedule();
            setTimeout(() => { status.set({ extra: '' }); scheduler.schedule(); }, 1200);
        },
        onSubmit: (text) => {
            if (!opts.onSubmit) return;
            opts.onSubmit(text);
            prompt.pushHistory(text);
            prompt.clear();
            scheduler.schedule();
        },
    });

    const footer = blessed.box({
        parent: screen,
        bottom: 0,
        left: 0,
        right: 0,
        height: 1,
        tags: true,
        style: { fg: FG_MUTED, bg: BG_PANEL },
    });

    const focus = createFocusRing({
        screen,
        panels: [
            { el: transcript.el, name: 'transcript', color: 'cyan' },
            { el: prompt.el, name: 'prompt', color: 'magenta' },
        ],
        footer,
        keymapText: '{gray-fg}Tab: toggle prompt  •  i: insert  •  Esc: NORMAL  •  Enter (NORMAL): submit  •  q: quit{/gray-fg}',
        onChange: (idx) => {
            const pane = idx === 0 ? 'transcript' : 'prompt';
            const mode: TuiMode = idx === 1
                ? (prompt.mode() as TuiMode)
                : (transcript.mode() as TuiMode);
            status.set({ pane, mode });
            // Mirror focus state into the panes so the cursor cell is only
            // highlighted on the focused pane.
            transcript.setFocused(idx === 0);
            prompt.setFocused(idx === 1);
            scheduler.schedule();
        },
    });

    // Tab toggles the prompt pane's visibility AND moves focus accordingly:
    //   - prompt visible  → Tab hides it and focuses transcript (fullscreen).
    //   - prompt hidden   → Tab shows it and focuses the prompt.
    // S-Tab mirrors the same semantics so either binding works.
    const togglePromptAndFocus = (): void => {
        const nowHidden = layout.togglePromptHidden();
        focus.focusAt(nowHidden ? 0 : 1);
    };
    screen.key(['tab'], togglePromptAndFocus);
    screen.key(['S-tab'], togglePromptAndFocus);
    void attachFocusCycleKeys; // kept imported for legacy callers

    attachLayout({
        screen,
        transcript: transcript.el,
        prompt: prompt.el,
        topChrome: 1,
        bottomChrome: 1,
        controller: layout,
        onLayout: () => scheduler.schedule(),
    });

    // Tail-lock policy: prompt visible ⇒ transcript pinned to bottom
    // (auto-scroll during streaming, ignore scroll keys). Prompt hidden
    // ⇒ free-scroll, even mid-stream. Initial state mirrors the layout.
    transcript.setTailLocked(!layout.config().promptHidden);
    layout.onChange((cfg) => {
        transcript.setTailLocked(!cfg.promptHidden);
    });

    // Start with the prompt pane focused so the user can immediately
    // start typing. The previous "transcript-then-Tab-then-Tab-again"
    // dance was a usability papercut.
    setBorder(prompt.el, 'magenta');
    prompt.el.focus();
    transcript.setFocused(false);
    prompt.setFocused(true);
    focus.focusAt(1);
    focus.renderFooter();

    // Now that the focus ring exists, hand the registry a real way to
    // give the user transcript-scroll focus when popups are hidden.
    focusTranscript = () => focus.focusAt(0);

    // Mouse-clicking the transcript while a popup is open would steal
    // keyboard focus from the popup, leaving it unreachable. Pull focus
    // back to the topmost overlay after each mouse event.
    screen.on('mouse', () => { setImmediate(() => popups.maintainFocus()); });

    // Submit + history are wired through createPromptPane's onSubmit. The
    // prompt itself owns its modal editor; no auto-INSERT on focus (Vim
    // convention: focus lands in NORMAL).

    let donePromise: Promise<void> | null = null;
    const done = async (): Promise<void> => {
        if (donePromise) return donePromise;
        donePromise = new Promise<void>((resolve) => {
            screen.once('destroy', () => {
                onExit();
                scheduler.stop();
                resolve();
            });
        });

        return donePromise;
    };

    return {
        screen,
        transcript,
        prompt,
        status,
        layout,
        focus,
        scheduler,
        appendTranscript: (text) => {
            transcript.append(text);
            scheduler.schedule();
        },
        appendMarkdown: (text) => {
            const { completed, tail } = mdRenderer.feed(text);
            consumeRenderedLines(completed);
            // setTail overwrites the in-progress last slot rather than appending,
            // so it stays in sync with the renderer's `pending` buffer.
            transcript.setTail(tail.plain, tail.styled);
            scheduler.schedule();
        },
        flushMarkdown: () => {
            const lines = mdRenderer.flush();
            consumeRenderedLines(lines);
            // Clear any leftover tail.
            transcript.setTail('', '');
            scheduler.schedule();
        },
        resetMarkdown: () => {
            mdRenderer.reset();
            transcript.setTail('', '');
        },
        markdown: mdRenderer,
        toolHistory,
        popups,
        spinner,
        setStatus: (patch) => {
            status.set(patch);
            scheduler.schedule();
        },
        quit: () => screen.destroy(),
        done,
    };
}
