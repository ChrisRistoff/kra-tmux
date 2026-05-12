/**
 * Stage 5 entrypoint: blessed-TUI chat replacement for the legacy nvim
 * chat. Spawned by `src/AI/AIChat/main/conversation.ts` via tmux.
 *
 * Argv (after `--tui-chat`):
 *   chatFile  provider  model  role  temperature  isLoaded(0|1)
 */

import * as fs from 'fs/promises';
import { bootstrapTuiApp } from '../host/bootstrapTui';
import { createTurnHeaderRenderer, type TurnHeaderRenderer } from '../host/turnHeaders';
import { wireSharedLeaderKeys } from '../host/leaderKeys';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { aiRoles } from '@/AI/shared/data/roles';
import { buildWelcomeBanner } from '@/AI/TUI/widgets/welcomeBanner';
import { promptModel } from '@/AI/AIChat/utils/promptModel';
import { loadSettings } from '@/utils/common';
import { createChatApprovalState, type ChatApprovalState } from '@/AI/AIChat/utils/chatToolApproval';
import { loadChatApprovalSettings } from '@/AI/AIChat/utils/chatApprovalSettings';
import { saveChat } from '@/AI/AIChat/utils/saveChat';
import { ChatData, ChatHistory, Role, StreamController } from '@/AI/shared/types/aiTypes';
import {
    extractTimestampFromHeader,
    formatAssistantHeader,
    formatUserHeader,
    isAssistantHeader,
    isUserHeader,
} from '@/AI/shared/utils/conversationUtils/chatHeaders';
import {
    getFileContextsForPrompt,
    clearFileContexts,
} from '@/AI/shared/utils/conversationUtils/fileContexts';
import { fileContexts } from '@/AI/shared/utils/conversationUtils/fileContextStore';
import type { ChatTuiApp } from '../chatTuiApp';
import type { ChatHost } from '../host/chatHost';
import { computeDrainCount, resolvePacerConfig } from '@/AI/shared/streamPacer';

interface ChatArgs {
    chatFile: string;
    provider: string;
    model: string;
    role: string;
    temperature: number;
    isLoaded: boolean;
}

function parseArgs(argv: string[]): ChatArgs {
    const [chatFile, provider, model, role, temperature, isLoaded] = argv;
    // `chatFile` is now a hydration hint, not a writable scratch file:
    //   - Empty string ('' or '-')   -> start a fresh chat in memory.
    //   - Non-empty + isLoaded=true  -> path to the saved chat JSON
    //                                   (read once at startup, never
    //                                   written to).
    if (!provider || !model) {
        throw new Error(`--tui-chat requires: <hydrationPath|''> <provider> <model> <role> <temperature> <isLoaded>`);
    }

    return {
        chatFile: chatFile === '-' ? '' : (chatFile ?? ''),
        provider,
        model,
        role: role || 'none',
        temperature: Number(temperature ?? 0.7),
        isLoaded: isLoaded === '1' || isLoaded === 'true',
    };
}

let currentStreamController: StreamController | null = null;
let approvalState: ChatApprovalState | null = null;
// Shared header renderer (chat + agent both use this so the user/assistant
// banner styling and the "USER (draft)" placeholder behave identically in
// both surfaces). Initialised once `bootstrapTuiApp` returns the app.
let headerRenderer: TurnHeaderRenderer | null = null;
// In-memory message history. We used to re-read + re-parse the entire
// chatFile on every submit (O(n) per turn) and once more on quit. The
// chatFile is now a write-only persistence + UI log; the source of
// truth for what we send to the model lives here, in memory.
let sessionMessages: ChatCompletionMessageParam[] = [];
let sessionTurns: ChatHistory[] = [];
async function getApprovalState(): Promise<ChatApprovalState> {
    if (!approvalState) {
        const { mode } = await loadChatApprovalSettings();
        approvalState = createChatApprovalState(mode);
    }

    return approvalState;
}

function createStreamController(): StreamController {
    let aborted = false;

    return {
        abort: () => { aborted = true; },
        get isAborted() { return aborted; },
    };
}

// `appendToChat` was removed: the chatFile is no longer the source of
// truth for the running TUI. Every transcript line is now held in
// `sessionTurns` and the blessed transcript widget. The previous per-
// chunk writeChain pinned streamed text in heap and was the dominant
// retainer behind the per-prompt RSS spike (300MB+ on long streams).

// Shared bring-up (redirect + app + pickers + host) lives in
// `../host/bootstrapTui` so chat and agent stay visually identical.

export async function runChatTui(argv: string[]): Promise<void> {
    const args = parseArgs(argv);

    // File contexts always start clean. Loaded chats currently don't
    // restore their file-context selection (the saved-chat JSON's
    // `fileContexts` field is honored by `loadChat` itself, before we
    // get here). We deliberately do NOT re-parse the chatFile to
    // rebuild file-context state — doing so was the dominant per-
    // prompt RSS source.
    clearFileContexts();

    let onSubmitImpl: (text: string) => void = () => { /* set later */ };
    const { app, pickers, chatHost: host } = bootstrapTuiApp({
        title: `chat · ${args.model}`,
        model: args.model,
        onSubmit: (text) => onSubmitImpl(text),
    });
    headerRenderer = createTurnHeaderRenderer(app);

    // Format the current `fileContexts` store as `path (N lines)` /
    // `path (lines a-b)` items — same shape both chat and agent show
    // under the USER (draft) banner.
    const formatAttachments = (): string[] => fileContexts.map((c) => {
        if (c.isPartial) {
            const range = c.startLine === c.endLine
                ? `line ${c.startLine}`
                : `lines ${c.startLine}-${c.endLine}`;

            return `${c.filePath} (${range})`;
        }

        return c.summary;
    });
    const refreshAttachments = (): void => {
        headerRenderer?.setAttachments(formatAttachments());
    };

    // SHARED leader-key wiring (chat + agent both call this so the
    // a/r/f/x/h/t items behave identically). Chat doesn't add extras.
    wireSharedLeaderKeys({
        app, pickers, chatHost: host, chatFile: args.chatFile,
        title: 'Leader (␣)',
        onContextsChanged: refreshAttachments,
        // C-c is wired separately via overrideCtrlCToStopStream below
        // so chat and agent share the same "C-c never quits" semantics.
    });

    // Replace the screen-level C-c quit binding so it stops the stream
    // when one is in flight; otherwise quit normally.
    overrideCtrlCToStopStream(app, () => {
        if (currentStreamController && !currentStreamController.isAborted) {
            currentStreamController.abort();
            app.setStatus({ extra: 'stream stopped' });

            return true;
        }

        return false;
    });

    // Hydrate from the saved chat JSON when loaded. The JSON is the
    // canonical persisted artifact — we read it ONCE here and never
    // touch the filesystem for chat state again. No `/tmp/ai-chat-*.md`
    // scratch file is created or written to during the session.
    if (args.isLoaded && args.chatFile) {
        try {
            const raw = await fs.readFile(args.chatFile, 'utf-8');
            const data = JSON.parse(raw) as ChatData;
            sessionTurns = Array.isArray(data.chatHistory) ? data.chatHistory : [];
            sessionMessages = chatHistoryToMessages(sessionTurns);
            for (const entry of sessionTurns) {
                const block = entry.role === Role.User
                    ? `${formatUserHeader(entry.timestamp)}${entry.message}\n`
                    : `${formatAssistantHeader(args.model, entry.timestamp)}${entry.message}\n`;
                app.appendMarkdown(block);
            }
            app.flushMarkdown();
            app.resetMarkdown();
            app.transcript.jumpToTail();
            void parseChatHistory; // legacy md-parser, no longer used
        } catch (err) {
            console.error('Failed to hydrate chat from JSON:', err);
        }
    }

    onSubmitImpl = (text: string): void => {
        if (!text.trim()) return;
        if (currentStreamController) {
            app.setStatus({ extra: 'already streaming — wait or C-c to stop' });

            return;
        }
        void handleSubmit(args, text, app, host);
    };

    // Fancy welcome banner above the first draft so the empty
    // transcript doesn't feel barren. Scrolls off naturally once the
    // conversation gets going.
    if (!args.isLoaded) {
        const elWidth = (app.transcript.el as unknown as { width: number }).width;
        const cols = (typeof elWidth === 'number' && elWidth > 0)
            ? elWidth
            : (process.stdout.columns ?? 80);
        const bannerLines = buildWelcomeBanner({
            title: '✦  K R A   ·   A I   C H A T  ✦',
            subtitle: `${args.provider} · ${args.model}`,
            viewportWidth: cols,
        });
        for (const line of bannerLines) {
            app.transcript.append(line.plain + '\n');
            if (line.styled) {
                app.transcript.setLineStyled(app.transcript.lineCount() - 2, line.styled);
            }
        }
        app.scheduler.schedule();
    }

    // Render the USER (draft) banner at startup so the user sees their
    // turn waiting from the moment the TUI mounts — same as in the
    // legacy nvim flow.
    headerRenderer.renderDraftBanner();

    app.setStatus({ extra: 'ready' });

    await app.done();

    // On exit: save chat directly from in-memory history. We no longer
    // re-read the file (which we were doing only to immediately re-parse
    // it back into the same shape we already had).
    try {
        await saveChat('', args.provider, args.model, args.role, args.temperature, sessionTurns);
    } catch (err) {
        console.error('Failed to save chat:', err);
    }
    // No scratch chatFile to remove — we never created one.
}



function overrideCtrlCToStopStream(app: ChatTuiApp, tryStop: () => boolean): void {
    // C-c is now a stream-stop ONLY. The screen no longer binds C-c to
    // quit (createDashboardScreen is invoked with `quitKeys: ['C-q']`),
    // so we just register a single handler that aborts any in-flight
    // stream. If no stream is running it is a silent no-op — the only
    // way to quit the app is C-q.
    app.screen.key('C-c', () => {
        if (tryStop()) return;
        app.setStatus({ extra: 'nothing to stop — press C-q to quit' });
    });
}


async function handleSubmit(
    args: ChatArgs,
    prompt: string,
    app: ChatTuiApp,
    host: ChatHost,
): Promise<void> {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) return;

    const turnTimestamp = new Date().toISOString();

    // Render the user-prompt header + body via the shared renderer (which
    // also rewinds past the previous turn's "USER (draft)" banner).
    headerRenderer?.renderUserHeader(trimmedPrompt, turnTimestamp);
    void formatUserHeader; // referenced indirectly above

    const fileContextPrompt = await getFileContextsForPrompt();
    const newUserMessage = trimmedPrompt + (fileContextPrompt ? `\n\n${fileContextPrompt}` : '');
    // Append to the in-memory transcript log immediately. The user
    // message is recorded as the original prompt (without the file
    // context blob) so saved-chat round-trips don't grow forever.
    sessionTurns.push({ role: Role.User, message: trimmedPrompt, timestamp: turnTimestamp });
    sessionMessages.push({ role: 'user', content: newUserMessage });
    const messages: ChatCompletionMessageParam[] = sessionMessages.slice();

    headerRenderer?.renderAssistantHeader(args.model, turnTimestamp);

    currentStreamController = createStreamController();
    app.setStatus({ streaming: true, extra: '' });

    try {
        const response = await promptModel(
            args.provider,
            args.model,
            messages,
            args.temperature,
            aiRoles[args.role] ?? '',
            currentStreamController,
            { host, chatFile: args.chatFile, approval: await getApprovalState() },
        );
        const assistantText = await streamResponse(response, args.chatFile, app, currentStreamController);
        sessionTurns.push({ role: Role.AI, message: assistantText.trim(), timestamp: turnTimestamp });
        sessionMessages.push({ role: 'assistant', content: stripToolMarkers(assistantText) });
    } catch (err: unknown) {
        if (currentStreamController.isAborted) {
            app.appendMarkdown('\n[Generation stopped by user]\n');
            app.flushMarkdown();
        } else {
            const msg = err instanceof Error ? err.message : String(err);
            app.appendMarkdown(`\n[Error: ${msg}]\n`);
            app.flushMarkdown();
        }
    } finally {
        app.flushMarkdown();
        currentStreamController = null;
        // "USER (draft)" placeholder so the user knows it's their turn.
        headerRenderer?.renderDraftBanner();
        app.setStatus({ streaming: false });
    }
}

async function streamResponse(
    response: AsyncIterable<string>,
    _chatFile: string,
    app: ChatTuiApp,
    controller: StreamController,
): Promise<string> {
    // Smoothness pacer — shared with agentSessionEvents so chat & agent
    // surfaces feel identical. Default = 1 char / 4 ms typewriter; bursts
    // ≥ dumpThreshold dump in one tick so we never fall behind.
    const iface = (await loadSettings()).ai?.chatInterface;
    const pacerCfg = resolvePacerConfig(iface);

    let trailingNewlines = 0;
    // Disk writes removed: the streamed text is held in the blessed
    // transcript widget + `assembled` (returned to the caller, who
    // appends it to `sessionTurns`). The previous writeChain queued one
    // promise per chunk and was the dominant retainer of streamed text
    // in heap.
    const enqueueDiskWrite = (_text: string): void => { /* no-op */ };
    const normalize = (chunk: string): string => {
        let out = '';
        for (const ch of chunk) {
            if (ch === '\n') {
                if (trailingNewlines < 2) out += ch;
                trailingNewlines++;
            } else {
                trailingNewlines = 0;
                out += ch;
            }
        }

        return out;
    };

    let pendingBuffer = '';
    let producerDone = false;
    // Accumulate the full assistant response so the caller can record
    // it in the in-memory transcript log without having to re-parse
    // the chatFile.
    let assembled = '';
    // Explicitly typed to keep TS from collapsing the assignment-in-Promise
    // pattern down to `never` once we later reassign it to null.
    const pacerState: { resolve: (() => void) | null } = { resolve: null };
    const pacerDone = new Promise<void>((resolve) => { pacerState.resolve = resolve; });

    const settle = (): void => {
        if (pacerState.resolve) {
            pacerState.resolve();
            pacerState.resolve = null;
        }
    };

    const drainOnce = (force: boolean): void => {
        if (!pendingBuffer) return;
        const drainCount = computeDrainCount(pendingBuffer.length, pacerCfg, force);
        const text = pendingBuffer.slice(0, drainCount);
        pendingBuffer = pendingBuffer.slice(drainCount);
        assembled += text;
        app.appendMarkdown(text);
        enqueueDiskWrite(text);
    };

    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleFlush = (): void => {
        if (flushTimer !== null) return;
        flushTimer = setTimeout(() => {
            flushTimer = null;
            if (pendingBuffer && !controller.isAborted) drainOnce(false);
            if (pendingBuffer && !controller.isAborted) {
                scheduleFlush();
            } else if (producerDone || controller.isAborted) {
                if (pendingBuffer && !controller.isAborted) drainOnce(true);
                settle();
            }
        }, pacerCfg.intervalMs);
    };

    // Tool-call lines are emitted by the model loop as discrete
    // single-chunk yields (`formatToolLine`). They aren't "prose" —
    // typewriting them feels laggy and obscures that the agent has
    // actually fired a tool. Detect and bypass the pacer for them.
    const TOOL_LINE_CHUNK = /^\n`[\u2713\u2717]\s[^`]*`\n$/;

    for await (const chunk of response) {
        if (controller.isAborted) break;
        const piece = normalize(chunk);
        if (!piece) continue;
        if (TOOL_LINE_CHUNK.test(piece)) {
            // Drain anything queued from the prose stream first so the
            // tool line lands in the correct order, then write the
            // tool line directly — no pacer, no typewriter.
            while (pendingBuffer && !controller.isAborted) drainOnce(true);
            assembled += piece;
            app.appendMarkdown(piece);
            enqueueDiskWrite(piece);
            continue;
        }
        pendingBuffer += piece;
        scheduleFlush();
    }

    producerDone = true;
    if (!pendingBuffer) {
        settle();
    } else {
        scheduleFlush();
    }

    await pacerDone;
    if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }

    return assembled;
}

// ---- chat parsing helpers (mirrors legacy conversation.ts) ----------------

function parseChatHistory(historyString: string): ChatHistory[] {
    const chatMessages: ChatHistory[] = [];
    const lines = historyString.split(/\n/);

    let currentRole: Role | null = null;
    let currentTextLines: string[] = [];
    let currentTimestamp = '';

    const flushMessage = (): void => {
        if (currentRole !== null && currentTextLines.length > 0) {
            const messageText = currentTextLines.join('\n').trim();
            if (messageText) {
                chatMessages.push({ role: currentRole, message: messageText, timestamp: currentTimestamp });
            }
        }
    };

    for (const line of lines) {
        const isUserMarker = isUserHeader(line) || line.startsWith('### USER (');
        const isAiMarker = isAssistantHeader(line) || line.startsWith('### AI -');
        if (isUserMarker || isAiMarker) {
            flushMessage();
            currentTimestamp = (isUserHeader(line) || isAssistantHeader(line))
                ? extractTimestampFromHeader(line)
                : (extractTimestamp(line) ?? '');
            currentRole = isUserMarker ? Role.User : Role.AI;
            currentTextLines = [];
        } else if (currentRole !== null) {
            currentTextLines.push(line);
        }
    }
    flushMessage();

    return chatMessages;
}

const TOOL_MARKER_LINE = /^\s*`[✓✗]\s[^`]*`\s*$/;
function stripToolMarkers(message: string): string {
    return message
        .replace(/```thinking[\s\S]*?```\s*/g, '')
        .split('\n')
        .filter((line) => !TOOL_MARKER_LINE.test(line))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function chatHistoryToMessages(history: ChatHistory[]): ChatCompletionMessageParam[] {
    return history
        .map<ChatCompletionMessageParam>((entry) => ({
            role: entry.role === Role.User ? 'user' : 'assistant',
            content: entry.role === Role.User ? entry.message : stripToolMarkers(entry.message),
        }))
        .filter((m) => typeof m.content === 'string' && m.content.length > 0);
}

function extractTimestamp(line: string): string | null {
    const match = line.match(/\(([^)]+)\)/);

    return match ? match[1] : null;
}


if (require.main === module) {
    runChatTui(process.argv.slice(3)).catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
