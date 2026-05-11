import * as fs from 'fs/promises';

/**
 * Shared chat header formatting used by both the AI chat and the agent UIs.
 * The chat file is the single source of truth for what the user sees in
 * Neovim, and these headers structure that file.
 *
 * Lifecycle of a USER PROMPT entry:
 *   1. A draft header (`USER PROMPT (draft)`) is written when a chat opens
 *      and again whenever the AI finishes a turn. This is the slot under
 *      which `@`-added file contexts visibly accumulate before submission.
 *   2. On submit, `materializeUserDraft` rewrites that draft header in
 *      place, replacing it with a timestamped header. The body (prompt
 *      text + any file context already appended) stays put.
 *   3. After the AI is done streaming, a fresh draft header is appended
 *      so the user has a place to type the next message.
 */

// Headers are emitted as `### ` (h3) so users can grep the chat file for
// `### ` to jump between conversation turns without false positives from
// markdown bodies that may contain `## ` for their own h2 sections.
export const USER_DRAFT_HEADER = '### 👤 USER PROMPT (draft)';
export const USER_HEADER_PREFIX = '### 👤 USER PROMPT · ';
export const ASSISTANT_HEADER_PREFIX = '### 🤖 ASSISTANT · ';
export const SUB_AGENT_HEADER_PREFIX = '### ';

/**
 * Render a Date / ISO string as a compact, human-readable local-time stamp
 * (e.g. `2024-01-15 14:30:45`). Used everywhere we emit a chat header so the
 * row is short enough to fit in narrow viewports without bleeding into the
 * next visual line. Returns the input verbatim if it can't be parsed as a
 * date — keeps backwards-compat with chat files that already contain a
 * non-standard timestamp string.
 */
export function formatHeaderTimestamp(
    timestamp: string | Date = new Date()
): string {
    const d = timestamp instanceof Date ? timestamp : new Date(timestamp);
    if (Number.isNaN(d.getTime())) {
        return typeof timestamp === 'string' ? timestamp : '';
    }
    const pad = (n: number): string => n.toString().padStart(2, '0');
    const yyyy = d.getFullYear();
    const mm = pad(d.getMonth() + 1);
    const dd = pad(d.getDate());
    const hh = pad(d.getHours());
    const mi = pad(d.getMinutes());
    const ss = pad(d.getSeconds());

    return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

export function formatSubAgentHeader(
    emoji: string,
    label: string,
    model: string,
    timestamp: string = new Date().toISOString()
): string {
    return `\n\n---\n### ${emoji} ${label.toUpperCase()} · ${model} · ${formatHeaderTimestamp(timestamp)}\n\n`;
}

export function formatUserDraftHeader(): string {
    return `\n\n---\n${USER_DRAFT_HEADER}\n\n`;
}

export function formatUserHeader(timestamp: string = new Date().toISOString()): string {
    return `\n\n---\n${USER_HEADER_PREFIX}${formatHeaderTimestamp(timestamp)}\n\n`;
}

export function formatAssistantHeader(
    model: string,
    timestamp: string = new Date().toISOString()
): string {
    return `\n\n---\n${ASSISTANT_HEADER_PREFIX}${model} · ${formatHeaderTimestamp(timestamp)}\n\n`;
}

export function isUserDraftHeader(line: string): boolean {
    return line.trim() === USER_DRAFT_HEADER;
}

export function isUserHeader(line: string): boolean {
    return line.startsWith(USER_HEADER_PREFIX);
}

export function isAssistantHeader(line: string): boolean {
    return line.startsWith(ASSISTANT_HEADER_PREFIX);
}

export function extractTimestampFromHeader(line: string): string {
    if (isUserHeader(line)) {
        return line.slice(USER_HEADER_PREFIX.length).trim();
    }

    if (isAssistantHeader(line)) {
        // Format: "### 🤖 ASSISTANT · model · timestamp"
        const remainder = line.slice(ASSISTANT_HEADER_PREFIX.length);
        const lastDot = remainder.lastIndexOf(' · ');

        return lastDot === -1 ? remainder.trim() : remainder.slice(lastDot + 3).trim();
    }

    return '';
}

/**
 * Replace the last `(draft)` marker in the chat file with a timestamped
 * USER header. No-op if no draft marker is present (e.g. when the agent
 * resumes mid-turn after `ask_kra`).
 */
export async function materializeUserDraft(
    filePath: string,
    timestamp: string = new Date().toISOString()
): Promise<void> {
    const content = await fs.readFile(filePath, 'utf-8');
    const idx = content.lastIndexOf(USER_DRAFT_HEADER);

    if (idx === -1) {
        return;
    }

    const updated =
        content.slice(0, idx) +
        `${USER_HEADER_PREFIX}${formatHeaderTimestamp(timestamp)}` +
        content.slice(idx + USER_DRAFT_HEADER.length);

    await fs.writeFile(filePath, updated, 'utf-8');
}
