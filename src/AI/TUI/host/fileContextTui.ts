/**
 * TUI orchestration for the chat file-context flow. Replaces the
 * nvim-coupled `handleAddFileContext` / `handleRemoveFileContext` /
 * `clearAllFileContexts` / `showFileContextsPopup` for the new TUI
 * surface. Re-uses the shared `fileContexts` store + display helpers so
 * the data shape is identical to the legacy flow.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import {
    fileContexts,
    upsertFileContext,
    clearStoredFileContexts,
    getFileExtension,
    getContextFileName,
} from '@/AI/shared/utils/conversationUtils/fileContextStore';
import {
    formatContextPickerItem,
    formatContextPopupEntry,
} from '@/AI/shared/utils/conversationUtils/fileContextDisplay';
import type { FileContext } from '@/AI/shared/types/aiTypes';
import type { ChatPickers, FilePickerSelection } from './pickers';
import type { ChatHost } from './chatHost';

const MAX_FILE_BYTES = 300_000;

function buildFullChatEntry(filePath: string, content: string): string {
    const fileName = path.basename(filePath);
    const ext = getFileExtension(fileName);
    const lineCount = content.split('\n').length;
    const sizeKB = Math.round(content.length / 1024);

    return `📁 ${fileName} (${lineCount} lines, ${sizeKB}KB)\n\n` +
        '```' + ext + '\n' +
        `// Full file content loaded: ${filePath}\n` +
        `// File contains ${lineCount} lines of ${ext} code\n` +
        '```\n\n';
}

function buildPartialChatEntry(
    filePath: string,
    selectedText: string,
    startLine: number,
    endLine: number,
): string {
    const fileName = path.basename(filePath);
    const ext = getFileExtension(fileName);
    const lineRange = startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;

    return `📁 ${fileName} (${lineRange})\n\n` +
        '```' + ext + '\n' +
        `// Selected from: ${filePath} (${lineRange})\n` +
        `${selectedText}\n` +
        '```\n\n';
}

// No-op: the chatFile is no longer the source of truth. File-context
// state lives in the in-memory `fileContexts` store; what the user sees
// in the transcript widget is fed via `host.appendChatLine`. We keep
// the signature so call sites stay diff-clean.
async function appendChatFile(_chatFile: string, _text: string): Promise<void> {
    return;
}

async function addEntireFile(
    chatFile: string,
    filePath: string,
    host: ChatHost,
    pickers: ChatPickers,
): Promise<boolean> {
    let content: string;
    try {
        content = await fs.readFile(filePath, 'utf-8');
    } catch (err) {
        pickers.notify(`failed to read ${path.basename(filePath)}: ${(err as Error).message}`);

        return false;
    }
    if (content.length > MAX_FILE_BYTES) {
        pickers.notify(`skipped (too large): ${path.basename(filePath)}`);

        return false;
    }
    const fileName = path.basename(filePath);
    const lineCount = content.split('\n').length;
    const chatEntry = buildFullChatEntry(filePath, content);
    upsertFileContext({
        filePath,
        isPartial: false,
        summary: `Full file: ${fileName} (${lineCount} lines)`,
        chatEntry,
    });
    await appendChatFile(chatFile, chatEntry);
    // The transcript is no longer used to render the file body — the
    // caller refreshes the "Attachments" list under the USER (draft)
    // banner via setAttachments() instead. This keeps the agent and
    // chat transcripts identical (just metadata, no file bodies).
    void host;

    return true;
}

async function addPartialFile(
    chatFile: string,
    filePath: string,
    host: ChatHost,
    pickers: ChatPickers,
): Promise<boolean> {
    let content: string;
    try {
        content = await fs.readFile(filePath, 'utf-8');
    } catch (err) {
        pickers.notify(`failed to read ${path.basename(filePath)}: ${(err as Error).message}`);

        return false;
    }
    const lines = content.split('\n');
    const range = await pickers.promptLineRange(filePath, lines.length);
    if (!range) {
        pickers.notify('cancelled');

        return false;
    }
    const selectedText = lines.slice(range.start - 1, range.end).join('\n');
    const fileName = path.basename(filePath);
    const lineRange = range.start === range.end ? `line ${range.start}` : `lines ${range.start}-${range.end}`;
    const chatEntry = buildPartialChatEntry(filePath, selectedText, range.start, range.end);
    upsertFileContext({
        filePath,
        isPartial: true,
        startLine: range.start,
        endLine: range.end,
        summary: `Partial file: ${fileName} (${lineRange})`,
        chatEntry,
    });
    await appendChatFile(chatFile, chatEntry);
    void host;

    return true;
}

async function addFolderEntries(
    chatFile: string,
    folderPath: string,
    host: ChatHost,
    pickers: ChatPickers,
): Promise<number> {
    let added = 0;
    const walk = async (dir: string): Promise<void> => {
        let entries: import('fs').Dirent[];
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (e.name.startsWith('.') || e.name === 'node_modules') continue;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) await walk(p);
            else if (e.isFile()) {
                if (await addEntireFile(chatFile, p, host, pickers)) added++;
            }
        }
    };
    await walk(folderPath);

    return added;
}

export async function runFileContextAdd(
    chatFile: string,
    pickers: ChatPickers,
    host: ChatHost,
): Promise<void> {
    const selections = await pickers.pickFilesOrFolders();
    if (!selections || selections.length === 0) {
        pickers.notify('cancelled');

        return;
    }
    const mode = await pickers.promptShareMode();
    if (!mode) {
        pickers.notify('cancelled');

        return;
    }

    let added = 0;
    for (const sel of selections) {
        if (sel.isDir && mode === 'entire') {
            added += await addFolderEntries(chatFile, sel.path.replace(/\/$/, ''), host, pickers);
            continue;
        }
        if (sel.isDir && mode === 'snippet') {
            const inner = await pickers.pickFileFromFolder(sel.path);
            if (!inner || inner.length === 0) continue;
            for (const f of inner) {
                if (await addPartialFile(chatFile, f, host, pickers)) added++;
            }
            continue;
        }
        if (mode === 'entire') {
            if (await addEntireFile(chatFile, sel.path, host, pickers)) added++;
        } else {
            if (await addPartialFile(chatFile, sel.path, host, pickers)) added++;
        }
    }
    pickers.notify(`added ${added} context(s)`);
}

export async function runFileContextRemove(
    chatFile: string,
    pickers: ChatPickers,
    host: ChatHost,
): Promise<void> {
    if (fileContexts.length === 0) {
        pickers.notify('no file contexts');

        return;
    }
    const items = await Promise.all(fileContexts.map(async (c, i) => formatContextPickerItem(c, i)));
    const indices = await pickers.pickContextsToRemove(items);
    if (!indices || indices.length === 0) {
        pickers.notify('cancelled');

        return;
    }
    const sorted = [...new Set(indices)].sort((a, b) => b - a);
    const removed: FileContext[] = [];
    for (const i of sorted) {
        if (i >= 0 && i < fileContexts.length) removed.push(fileContexts.splice(i, 1)[0]);
    }
    await stripChatEntries(chatFile, removed);
    const names = removed.map((c) => getContextFileName(c.filePath)).reverse().join(', ');
    pickers.notify(`removed ${removed.length}: ${names}`);
    void host;
}

// No-op: nothing to strip from — the chatFile isn't being written.
// `fileContexts` has already been mutated by the caller (splice). The
// `removed` arg is retained so the contract matches existing tests.
async function stripChatEntries(_chatFile: string, _removed: FileContext[]): Promise<void> {
    return;
}

export async function runFileContextShow(pickers: ChatPickers): Promise<void> {
    if (fileContexts.length === 0) {
        pickers.notify('no file contexts');

        return;
    }
    const lines: string[] = ['💡 Tip: press "r" to remove files from the context', ''];
    for (const [i, c] of fileContexts.entries()) {
        const block = await formatContextPopupEntry(c, i);
        lines.push(...block);
    }
    await pickers.showContextsPopup('active file contexts', lines);
}

export async function runFileContextClear(
    chatFile: string,
    pickers: ChatPickers,
    host: ChatHost,
): Promise<void> {
    if (fileContexts.length === 0) {
        pickers.notify('no file contexts');

        return;
    }
    const ok = await pickers.confirm('clear contexts?', `Remove all ${fileContexts.length} file context(s)?`);
    if (!ok) return;
    const removed = fileContexts.slice();
    clearStoredFileContexts();
    await stripChatEntries(chatFile, removed);
    pickers.notify(`cleared ${removed.length} context(s)`);
    void host;
}

// Re-export fileContexts for the entrypoint to inspect during rebuild.
export { fileContexts } from '@/AI/shared/utils/conversationUtils/fileContextStore';

// Type alias kept for downstream consumers.
export type { FilePickerSelection };
