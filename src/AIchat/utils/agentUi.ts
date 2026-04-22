interface ToolResultSummary {
    content: string;
    detailedContent?: string;
}

const TOOL_TEXT_MAX_LINES = 14;
const TOOL_TEXT_MAX_LENGTH = 1200;
const AGENT_DRAFT_HEADER = '## 👤 USER PROMPT (draft)';

/** One line written to the chat file when a tool finishes. */
export function formatToolLine(toolSummary: string, success: boolean): string {
    const icon = success ? '✓' : '✗';
    return `\n\`${icon} ${toolSummary}\`\n`;
}

/**
 * Written to the chat file when confirm_task_complete fires so the user can
 * see what the AI is asking before and after they answer the popup.
 */
export function formatConfirmQuestion(question: string, choices: string[]): string {
    const choiceLines = choices.map((c) => `- ${c}`).join('\n');
    return `\n---\n\n**💬 ${question}**\n\n${choiceLines}\n\n`;
}

export function formatConfirmAnswer(answer: string): string {
    const timestamp = new Date().toISOString();
    return `\n---\n\n## 👤 USER PROMPT · ${timestamp}\n\n${answer}\n\n`;
}

function truncateMultiline(value: string): string {
    const lines = value.trim().split('\n');
    const clippedLines = lines.slice(0, TOOL_TEXT_MAX_LINES);
    let truncated = clippedLines.join('\n');

    if (lines.length > TOOL_TEXT_MAX_LINES) {
        truncated += '\n…';
    }

    if (truncated.length > TOOL_TEXT_MAX_LENGTH) {
        truncated = `${truncated.slice(0, TOOL_TEXT_MAX_LENGTH - 1)}…`;
    }

    return truncated;
}

function extractErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    if (typeof error === 'string') {
        return error;
    }

    if (error && typeof error === 'object' && 'message' in error) {
        const message = (error as { message?: unknown }).message;

        if (typeof message === 'string') {
            return message;
        }
    }

    return 'Tool failed.';
}

export function formatAgentConversationEntry(
    role: 'USER' | 'ASSISTANT',
    options?: { model?: string, timestamp?: string }
): string {
    const timestamp = options?.timestamp || new Date().toISOString();
    const parts: string[] = [
        role === 'USER' ? '👤 USER PROMPT' : '🤖 ASSISTANT RESPONSE',
    ];

    if (options?.model) {
        parts.push(options.model);
    }

    parts.push(timestamp);

    return `\n---\n\n## ${parts.join(' · ')}\n\n`;
}

export function formatAgentDraftEntry(): string {
    return `\n---\n\n${AGENT_DRAFT_HEADER}\n\n`;
}

export function isAgentUserHeader(line: string): boolean {
    return line.startsWith('## 👤 USER PROMPT · ');
}

export function isAgentDraftHeader(line: string): boolean {
    return line === AGENT_DRAFT_HEADER;
}

function trimBlankEdges(lines: string[]): string[] {
    let start = 0;
    let end = lines.length;

    while (start < end && !lines[start].trim()) {
        start += 1;
    }

    while (end > start && !lines[end - 1].trim()) {
        end -= 1;
    }

    return lines.slice(start, end);
}

export function extractAgentDraftPrompt(lines: string[]): string {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (isAgentDraftHeader(lines[index])) {
            return trimBlankEdges(lines.slice(index + 1)).join('\n');
        }
    }

    return '';
}

export function materializeAgentDraft(lines: string[], timestamp?: string): string {
    let draftIndex = -1;

    for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (isAgentDraftHeader(lines[index])) {
            draftIndex = index;
            break;
        }
    }

    if (draftIndex === -1) {
        return lines.join('\n');
    }

    const prompt = extractAgentDraftPrompt(lines);
    const prefix = lines.slice(0, draftIndex);

    while (prefix.length > 0 && !prefix[prefix.length - 1].trim()) {
        prefix.pop();
    }

    const header = formatAgentConversationEntry(
        'USER',
        timestamp ? { timestamp } : undefined
    ).trimStart();
    const body = prompt ? `${prompt}\n` : '';

    return `${prefix.join('\n')}\n${header}${body}`;
}

export function summarizeToolCall(
    toolName: string,
    argumentsData?: Record<string, unknown>
): string {
    const summaryValue =
        (typeof argumentsData?.query === 'string' && argumentsData.query) ||
        (typeof argumentsData?.command === 'string' && argumentsData.command) ||
        (typeof argumentsData?.path === 'string' && argumentsData.path) ||
        (typeof argumentsData?.url === 'string' && argumentsData.url) ||
        (typeof argumentsData?.prompt === 'string' && argumentsData.prompt);

    if (!summaryValue) {
        return toolName;
    }

    const compact = summaryValue.replace(/\s+/g, ' ').trim();
    const truncated = compact.length > 60 ? `${compact.slice(0, 59)}…` : compact;

    return `${toolName}: ${truncated}`;
}

export function formatToolDisplayName(
    toolName: string,
    mcpServerName?: string,
    mcpToolName?: string
): string {
    return mcpServerName
        ? `${mcpServerName}:${mcpToolName || toolName}`
        : toolName;
}

export function formatToolArguments(argumentsData?: Record<string, unknown>): string {
    if (!argumentsData || !Object.keys(argumentsData).length) {
        return 'No arguments.';
    }

    return truncateMultiline(JSON.stringify(argumentsData, null, 2));
}

export function formatToolProgress(progressMessage: string): string {
    return truncateMultiline(progressMessage);
}

export function formatToolCompletion(
    success: boolean,
    result?: ToolResultSummary,
    error?: unknown
): string {
    if (!success) {
        return truncateMultiline(extractErrorMessage(error));
    }

    const resultText = result?.detailedContent || result?.content || 'Completed successfully.';

    return truncateMultiline(resultText);
}
