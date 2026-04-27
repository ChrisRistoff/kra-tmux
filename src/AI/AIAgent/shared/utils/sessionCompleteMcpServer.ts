/**
 * Minimal stdio MCP server that exposes a single tool: confirm_task_complete.
 *
 * The AI is instructed to call this tool whenever it believes the task is
 * done OR whenever it needs to ask the user anything (clarifications,
 * decisions, next steps). The real handling happens in onPreToolUse in
 * agentConversation.ts — this server just needs to satisfy the MCP
 * protocol so the SDK can discover and call the tool.
 *
 * Run directly: node dest/AI/AIAgent/utils/sessionCompleteMcpServer.js
 */

import { runStdioMcpServer } from '../../mcp/stdioServer';

const TOOL_DEFINITION = {
    name: 'confirm_task_complete',
    description: [
        'You MUST call this tool in two situations:',
        '1. When you believe all assigned tasks are complete and you want to end your turn.',
        '2. When you need to ask the user anything — clarifications, decisions, follow-up questions, or next steps.',
        'Do NOT end your turn with plain text. Always call this tool instead.',
        'Pass a concise summary of what was done (or what you need to ask) in the "summary" argument,',
        'and a list of 2–4 concrete choices for the user in the "choices" argument.',
        'The user will pick a choice or type a custom reply; their answer will be returned to you so you can continue.',
    ].join(' '),
    inputSchema: {
        type: 'object',
        properties: {
            summary: {
                type: 'string',
                description: 'A concise summary of what was accomplished, or what question you are asking the user.',
            },
            choices: {
                type: 'array',
                items: { type: 'string' },
                description: 'Two to four concrete choices to present to the user (e.g. ["Continue with X", "Try Y instead", "We are done"]).',
            },
        },
        required: ['summary', 'choices'],
    },
};

runStdioMcpServer({
    serverName: 'kra-session-complete',
    tools: [TOOL_DEFINITION],
    allowPing: true,
    respondParseError: false,
    handleToolCall: async () => ({
        content: [{ type: 'text', text: 'User has been prompted. Continue based on their reply.' }],
        isError: false,
    }),
});
