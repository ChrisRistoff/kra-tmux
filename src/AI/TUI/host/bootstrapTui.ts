import { createChatTuiApp, type ChatTuiApp } from '@/AI/TUI/chatTuiApp';
import { createTuiChatPickers, type ChatPickers } from '@/AI/TUI/host/pickers';
import { createTuiChatHost, type ChatHost } from '@/AI/TUI/host/chatHost';
import { installConsoleRedirect, type ConsoleRedirectHandle } from '@/AI/TUI/host/consoleRedirect';

export interface BootstrapTuiOptions {
    title: string;
    model: string;
    onSubmit?: (text: string) => void;
    onExit?: () => void;
}

export interface BootstrapTuiResult {
    app: ChatTuiApp;
    pickers: ChatPickers;
    chatHost: ChatHost;
    redirect: ConsoleRedirectHandle;
}

/**
 * Single source of truth for bringing up the AI TUI surface (screen + app +
 * pickers + chat host). Both AIChat (`runChatTui`) and AIAgent
 * (`converseAgent`) call this so visual / streaming / picker / approval
 * behaviour stays in lock-step. Anything that should look or act the same
 * in chat and agent goes here; only TRUE deviations (agent-specific
 * widgets) live outside this helper.
 *
 * Side effects:
 *   - Calls `installConsoleRedirect()` to prevent any stdout/stderr / console
 *     write from bleeding into the blessed framebuffer (visible as ghost
 *     characters and terminal-background bleed in pane gaps).
 *   - Hands the protected output stream to blessed so renders survive the
 *     redirect.
 */
export function bootstrapTuiApp(opts: BootstrapTuiOptions): BootstrapTuiResult {
    const redirect = installConsoleRedirect();

    const app = createChatTuiApp({
        title: opts.title,
        model: opts.model,
        output: redirect.blessedOutput,
        ...(opts.onSubmit ? { onSubmit: opts.onSubmit } : {}),
        ...(opts.onExit ? { onExit: opts.onExit } : {}),
    });

    const pickers = createTuiChatPickers({
        screen: app.screen,
        onNotify: (msg) => {
            app.setStatus({ extra: msg });
            setTimeout(() => app.setStatus({ extra: '' }), 2000);
        },
    });

    const chatHost = createTuiChatHost({ app, pickers });

    return { app, pickers, chatHost, redirect };
}
