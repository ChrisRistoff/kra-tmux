/**
 * Bridges the chat to the agent's existing tool-permission popup
 * (`require('kra_agent.ui').request_permission`).
 *
 * The agent's `promptToolApproval` is generic: it takes a neovim client, a
 * `{toolName, toolArgs, agentLabel?}` input, and a workspacePath used only by
 * the diff-preview path (chat tools never write files, so the workspace path
 * is incidental). We keep an in-memory `ChatApprovalState` so `allow-family`
 * (one approval per tool name) and `yolo` (silence everything) decisions made
 * via the popup persist across tool calls within the same chat session — and
 * across both the outer chat tools and the `deep_search` inner-loop tools.
 */

import * as neovim from 'neovim';

import { promptToolApproval } from '@/AI/AIAgent/shared/utils/agentToolHook';
import { getToolFamily, shouldAutoApproveTool } from '@/AI/AIAgent/shared/utils/agentToolApproval';

export type ChatApprovalMode = 'strict' | 'yolo';

export interface ChatApprovalState {
    mode: ChatApprovalMode;
    allowedFamilies: Set<string>;
}

export function createChatApprovalState(mode: ChatApprovalMode = 'strict'): ChatApprovalState {
    return { mode, allowedFamilies: new Set<string>() };
}

export interface ChatApprovalRequest {
    toolName: string;
    toolArgs: unknown;
    /**
     * Optional label that prefixes the popup title so users can tell which
     * surface issued the call (e.g. `deep_search` for inner-loop calls).
     */
    agentLabel?: string;
}

export type ChatApprovalDecision =
    | { action: 'allow', modifiedArgs?: unknown }
    | { action: 'deny', denyReason?: string };

/**
 * Consult the approval state and prompt the user via the agent's existing
 * Neovim popup if needed. Updates `state` in place when the user picks
 * `allow-family` or `yolo`.
 */
export async function requestChatToolApproval(
    nvim: neovim.NeovimClient,
    state: ChatApprovalState,
    req: ChatApprovalRequest,
): Promise<ChatApprovalDecision> {
    if (state.mode === 'yolo' || shouldAutoApproveTool(req.toolName)) {
        return { action: 'allow' };
    }

    const family = getToolFamily(req.toolName);
    if (state.allowedFamilies.has(family)) {
        return { action: 'allow' };
    }

    const { decision } = await promptToolApproval(
        nvim,
        {
            toolName: req.toolName,
            toolArgs: req.toolArgs,
            ...(req.agentLabel ? { agentLabel: req.agentLabel } : {}),
        },
        process.cwd(),
    );

    if (decision.action === 'allow-family') {
        state.allowedFamilies.add(family);

        return { action: 'allow' };
    }

    if (decision.action === 'yolo') {
        state.mode = 'yolo';

        return { action: 'allow' };
    }

    if (decision.action === 'allow') {
        return decision.modifiedArgs !== undefined
            ? { action: 'allow', modifiedArgs: decision.modifiedArgs }
            : { action: 'allow' };
    }

    return decision.denyReason
        ? { action: 'deny', denyReason: decision.denyReason }
        : { action: 'deny' };
}
