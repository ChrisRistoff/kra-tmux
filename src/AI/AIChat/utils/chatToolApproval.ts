/**
 * Chat tool-permission state + approval bridge. Stage 5 refactor: this no
 * longer talks to Neovim — it consults a `ChatHost` (TUI for the chat
 * surface, future: an nvim adapter for the agent surface).
 *
 * State is per-process; `allow-family` and `yolo` decisions persist across
 * tool calls within the same chat session.
 */

import type { ChatHost } from '@/AI/TUI/host/chatHost';
import { getToolFamily, shouldAutoApproveTool } from '@/AI/AIAgent/shared/utils/agentToolApproval';
import { buildChatApprovalPayload } from './buildChatApprovalPayload';

export type ChatApprovalMode = 'strict' | 'yolo';

export interface ChatApprovalState {
    mode: ChatApprovalMode;
    allowedFamilies: Set<string>;
}

export function createChatApprovalState(mode: ChatApprovalMode = 'strict'): ChatApprovalState {
    return { mode, allowedFamilies: new Set<string>() };
}

// `ChatApprovalRequest` here is the *call-site* shape (toolName + raw args).
// It gets transformed into the rich `ToolApprovalPayload` (the host-facing
// shape, defined in `widgets/approvalModal`) before being shown.
export interface ChatApprovalRequest {
    toolName: string;
    toolArgs: unknown;
    agentLabel?: string;
}

export type ChatApprovalDecision =
    | { action: 'allow', modifiedArgs?: unknown }
    | { action: 'deny', denyReason?: string };

/**
 * Consult the approval state and prompt the user via the host's modal if
 * needed. Updates `state` in place when the user picks `allow-family` or
 * `yolo`.
 */
export async function requestChatToolApproval(
    host: ChatHost,
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

    const decision = await host.requestApproval(buildChatApprovalPayload({
        toolName: req.toolName,
        toolArgs: req.toolArgs,
        ...(req.agentLabel ? { agentLabel: req.agentLabel } : {}),
    }));

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
