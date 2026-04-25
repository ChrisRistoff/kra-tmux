/**
 * Reactive context-window compactor for BYOK sessions.
 *
 * Strategy: when the LLM rejects a request with a context-length error (or when
 * an estimated token budget is exceeded), summarize the older half of the
 * message history into a single "system" message and replace those messages
 * with the summary. The most recent K messages and the system prompt are kept
 * verbatim so the agent never loses immediate context.
 *
 * Estimation is intentionally crude (chars / 4) — it's a fallback heuristic
 * for providers that don't report token usage on streaming responses.
 */

import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

const KEEP_RECENT = 10;
const CHARS_PER_TOKEN = 4;

export function estimateTokens(messages: ChatCompletionMessageParam[]): number {
    let total = 0;

    for (const msg of messages) {
        if (typeof msg.content === 'string') {
            total += msg.content.length;
        } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if ('text' in part && typeof part.text === 'string') {
                    total += part.text.length;
                }
            }
        }
    }

    return Math.ceil(total / CHARS_PER_TOKEN);
}

export function isContextLengthError(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }

    const msg = error.message.toLowerCase();

    return (
        msg.includes('context length') ||
        msg.includes('context_length') ||
        msg.includes('maximum context') ||
        msg.includes('too many tokens') ||
        msg.includes('reduce the length')
    );
}

interface CompactOptions {
    openai: OpenAI;
    model: string;
    messages: ChatCompletionMessageParam[];
}

export async function compactMessages(
    options: CompactOptions
): Promise<ChatCompletionMessageParam[]> {
    const { openai, model, messages } = options;

    if (messages.length <= KEEP_RECENT + 2) {
        return messages;
    }

    const systemMessages = messages.filter((m) => m.role === 'system');
    const nonSystem = messages.filter((m) => m.role !== 'system');
    const recent = nonSystem.slice(-KEEP_RECENT);
    const older = nonSystem.slice(0, -KEEP_RECENT);

    if (older.length === 0) {
        return messages;
    }

    const transcript = older
        .map((m) => {
            const content =
                typeof m.content === 'string'
                    ? m.content
                    : JSON.stringify(m.content);

            return `[${m.role}] ${content}`;
        })
        .join('\n\n');

    const summaryResponse = await openai.chat.completions.create({
        model,
        stream: false,
        messages: [
            {
                role: 'system',
                content:
                    'You are a conversation compactor. Summarize the following agent transcript ' +
                    'into a concise but information-dense recap. Preserve: user goals, key decisions, ' +
                    'files touched, errors hit and their resolutions, outstanding TODOs, and any ' +
                    'facts the agent must remember. Use bullet points. Output ONLY the summary.',
            },
            { role: 'user', content: transcript },
        ],
    });

    const summary =
        summaryResponse.choices[0]?.message?.content ?? '(compaction produced no content)';

    return [
        ...systemMessages,
        {
            role: 'system',
            content: `<compacted_history>\n${summary}\n</compacted_history>`,
        },
        ...recent,
    ];
}
