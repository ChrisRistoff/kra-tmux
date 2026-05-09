/**
 * Settings for the chat-side tool-permission system.
 *
 * Reads `[ai.chat.approval]` from `~/.kra/settings.toml`. Default mode is
 * `strict` so users get prompted (mirrors the agent default). Set to `yolo`
 * to silence the popup entirely.
 */

import * as toml from 'smol-toml';
import { promises as fs } from 'fs';

import { settingsFilePath } from '@/filePaths';
import type { ChatApprovalMode } from '@/AI/AIChat/utils/chatToolApproval';

export interface ChatApprovalSettings {
    mode: ChatApprovalMode;
}

interface RawApproval {
    mode?: string;
}

export async function loadChatApprovalSettings(): Promise<ChatApprovalSettings> {
    let raw: RawApproval | undefined;

    try {
        const content = await fs.readFile(settingsFilePath, 'utf8');
        const parsed = toml.parse(content) as { ai?: { chat?: { approval?: RawApproval } } };
        raw = parsed.ai?.chat?.approval;
    } catch {
        // settings.toml missing — fall through to defaults.
    }

    const mode: ChatApprovalMode = raw?.mode === 'yolo' ? 'yolo' : 'strict';

    return { mode };
}
