import * as ai from "@/AI";
import { AiCommands } from "@/commandsMaps/types/commandTypes";

export const aiCommands: AiCommands = {
    'chat': {
        run: ai.startNewChat,
        description: 'Start a fresh AI chat session',
        details: 'Open the direct Neovim chat workflow for back-and-forth prompting with streaming responses, file context, and built-in web tools.',
        highlights: [
            'Real-time streaming chat inside Neovim.',
            'Supports file context and visual selections as prompt context.',
            'Includes built-in web search and fetch tooling during chat sessions.',
        ],
    },
    'agent': {
        run: ai.startAgentChat,
        description: 'Launch an autonomous AI agent session',
        details: 'Start the full agent workflow with provider selection, tool approvals, repo edits as uncommitted diffs, and interactive review in Neovim.',
        highlights: [
            'Supports Copilot and BYOK providers behind one command.',
            'Includes diff review, apply or reject flow, and per-file revert history.',
            'Can use project MCP servers and repo-aware tools while working.',
        ],
    },
    'load': {
        run: ai.loadChat,
        description: 'Open a previously saved AI chat',
        details: 'Browse saved chat sessions, inspect their metadata and summary, and reopen the selected conversation in the active chat workflow.',
        highlights: [
            'Shows saved conversation summaries before loading.',
            'Useful for resuming long-running work without losing context.',
            'Keeps saved-chat browsing inside the same shared picker patterns.',
        ],
    },
    'delete': {
        run: ai.deleteChats,
        description: 'Delete saved AI chat sessions',
        details: 'Review saved chat sessions and remove the ones you no longer need from disk.',
        highlights: [
            'Helps clean up saved AI history intentionally rather than by hand.',
            'Uses the same saved-chat metadata used by the load flow.',
            'Makes deletion explicit instead of hiding it in filesystem paths.',
        ],
    },
    'quota-agent': {
        run: ai.showQuota,
        description: 'Inspect quota and usage for the AI layer',
        details: 'Open the quota view to see how much AI usage budget remains before starting heavier chat or agent work.',
        highlights: [
            'Surfaces current usage information in one place.',
            'Useful before longer agent sessions or expensive model choices.',
            'Complements the runtime quota warnings with an explicit dashboard.',
        ],
    },
    'index': {
        run: ai.indexCodebase,
        description: 'Index the repository for code-aware AI features',
        details: 'Run the repo indexing flow that powers code-aware semantic search and other repo-context AI features.',
        highlights: [
            'Builds the local code index used by repo-aware AI lookups.',
            'Useful when you want a fresh manual index outside auto or catch-up flows.',
            'Works with the persistent memory and semantic-search tooling.',
        ],
    },
};