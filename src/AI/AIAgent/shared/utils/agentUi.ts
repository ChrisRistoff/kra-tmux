import type { ToolResultSummary } from '@/AI/AIAgent/shared/types/agentTypes';


const TOOL_TEXT_MAX_LINES = 14;
const TOOL_TEXT_MAX_LENGTH = 1200;
import { formatUserHeader } from '@/AI/shared/utils/conversationUtils/chatHeaders';

/** One line written to the chat file when a tool finishes. */
export function formatToolLine(toolSummary: string, success: boolean): string {
    const icon = success ? '✓' : '✗';

    return `\n\`${icon} ${toolSummary}\`\n`;
}

/**
 * Written to the chat file when ask_kra fires so the user can
 * see what the AI is asking before and after they answer the popup.
 */
export function formatConfirmQuestion(question: string, choices: string[]): string {
    const choiceLines = choices.map((c) => `- ${c}`).join('\n');

    return `\n\n---\n**💬 ${question}**\n\n${choiceLines}\n\n`;
}

export function formatConfirmAnswer(answer: string): string {
    return `${formatUserHeader()}${answer}\n\n`;
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


export function formatSubmittedAgentPrompt(prompt: string): string {
    const normalizedPrompt = prompt.trim();

    return normalizedPrompt ? `${normalizedPrompt}\n` : '';
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
        ? `${mcpServerName}:${mcpToolName ?? toolName}`
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
        const errorText = extractErrorMessage(error);
        if (errorText !== 'Tool failed.') {
            return truncateMultiline(errorText);
        }

        const fallback = result?.detailedContent ?? result?.content;
        if (fallback) {
            return truncateMultiline(fallback);
        }

        return truncateMultiline(errorText);
    }

    const resultText = result?.detailedContent ?? result?.content ?? 'Completed successfully.';

    return truncateMultiline(resultText);
}
