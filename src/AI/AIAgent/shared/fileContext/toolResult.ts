/**
 * Shared MCP tool-result types used by every fileContext handler.
 */
export interface ToolResult {
    content: { type: 'text'; text: string }[];
    isError: boolean;
}

export function textContent(text: string): ToolResult {
    return { content: [{ type: 'text', text }], isError: false };
}

export function errorContent(text: string): ToolResult {
    return { content: [{ type: 'text', text }], isError: true };
}
