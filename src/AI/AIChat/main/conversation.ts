/**
 * Stage 6: chat now runs IN-PROCESS via the shared TUI bring-up
 * (`runChatTui`), exactly like the agent does. No tmux subprocess,
 * no `--tui-chat` round-trip — we just call the entrypoint directly
 * so the chat and agent share one bootstrap path.
 */

import * as fs from 'fs/promises';
import { formatUserDraftHeader } from '@/AI/shared/utils/conversationUtils/chatHeaders';
import { runChatTui } from '@/AI/TUI/cli/chatTui';

export async function converse(
    chatFile: string,
    temperature: number,
    role: string,
    provider: string,
    model: string,
    isChatLoaded = false,
): Promise<void> {
    // `chatFile` is now ONLY a hydration hint passed through to chatTui:
    //   - Empty string  -> start fresh, no file involved.
    //   - Non-empty path with isChatLoaded=true -> path to the saved
    //     chat JSON; chatTui reads it once at startup and runs purely
    //     in memory afterwards.
    // We no longer create a `/tmp/ai-chat-*.md` scratch file. That file
    // was the dominant retainer of streamed text in heap.
    void initializeChatFile;

    // Same in-process bring-up as the agent: hand the args straight to
    // runChatTui. tmux is not a factor; the user-facing UX (pane vs
    // inline) is identical to `kra ai agent`.
    await runChatTui([
        chatFile,
        provider,
        model,
        role,
        String(temperature),
        isChatLoaded ? '1' : '0',
    ]);
}


export async function initializeChatFile(filePath: string, userPrompt = false): Promise<void> {
    const initialContent = `
# AI Chat History

This file contains the conversation history between the user and AI.

        # Controls / Shortcuts:
        #   Enter          -> Submit prompt (NORMAL mode in prompt pane)
        #   Tab / S-Tab    -> Switch between transcript and prompt
        #   @              -> Add file context (NORMAL prompt)
        #   r              -> Remove file context  (NORMAL prompt)
        #   f              -> Show current file contexts (NORMAL prompt)
        #   <C-x>          -> Clear contexts (NORMAL prompt)
        #   <C-c>          -> Stop stream (when streaming) / quit otherwise
        #
        # Tip: Type your next message in the bottom prompt split.
`;

    const finalContent = userPrompt
        ? `${initialContent}${formatUserDraftHeader()}`
        : initialContent;

    await fs.writeFile(filePath, finalContent, 'utf-8');
}
