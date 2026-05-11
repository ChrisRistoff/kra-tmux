import * as fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { AgentHost } from '@/AI/TUI/host/agentHost';
import {
    coerceNumber,
    coerceNumberArray,
    extractAnchorEditRequest,
    extractEditRequest,
    extractWriteRequest,
    getToolArgsRecord,
    getToolFamily,
    shouldAutoApproveTool,
    type AnchorEdit,
} from '@/AI/AIAgent/shared/utils/agentToolApproval';
import {
    formatConfirmAnswer,
    formatConfirmQuestion,
    formatToolProgress,
} from '@/AI/AIAgent/shared/utils/agentUi';
import { formatAssistantHeader } from '@/AI/shared/utils/conversationUtils/chatHeaders';
import { getFileOutline, formatOutline } from '@/AI/AIAgent/shared/utils/fileOutline';
import { recall } from '@/AI/AIAgent/shared/memory/notes';
import { semanticSearch } from '@/AI/AIAgent/shared/memory/search';
import { isMemoryLookupKind } from '@/AI/AIAgent/shared/memory/types';
import * as bash from '@/utils/bashHelper';
import type {
    AgentConversationState,
    AgentPreToolUseHookInput,
    AgentPreToolUseHookOutput,
    AgentUserInputResponse,
    ToolApprovalResult,
    ToolWritePreview,
} from '@/AI/AIAgent/shared/types/agentTypes';
import { atomicWriteFile } from '@/AI/AIAgent/shared/utils/fileSafety';

// Matches the kra-file-context 'anchor_edit' tool. We require the trailing
// 'edit' token to be preceded by a separator (start-of-string or one of the
// MCP-namespacing characters) so we match `anchor_edit`, `kra-file-context__anchor_edit`,
// `kra-file-context-anchor_edit`, etc., but never `str_replace_editor`/`edit_file`.
// (The legacy bare name `edit` also matches via start-of-string.)
function isAnchorEditTool(name: string): boolean {
    return /(?:^|[_:\-.])edit$/.test(name);
}

function quoteForShell(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function readFileOrEmpty(filePath: string): Promise<string> {
    try {
        return await fs.readFile(filePath, 'utf8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return '';
        }
        throw err;
    }
}

// Run `git diff --no-index` on two strings via temp files. Always cleans up.
async function computeDiff(currentContent: string, proposedContent: string): Promise<string> {
    const tempSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const currentPath = path.join(os.tmpdir(), `kra-agent-current-${tempSuffix}`);
    const proposedPath = path.join(os.tmpdir(), `kra-agent-proposed-${tempSuffix}`);

    await fs.writeFile(currentPath, currentContent, 'utf8');
    await fs.writeFile(proposedPath, proposedContent, 'utf8');

    try {
        const result = await bash.execCommand(
            `git --no-pager diff --no-index -- ${quoteForShell(currentPath)} ${quoteForShell(proposedPath)} || true`
        );

        return result.stdout.trim();
    } finally {
        await fs.rm(currentPath, { force: true });
        await fs.rm(proposedPath, { force: true });
    }
}

export async function appendToChat(file: string, content: string): Promise<void> {
    await fs.appendFile(file, content, 'utf-8');
}

/**
 * Show the agent's user-input popup and resolve with the user's answer.
 */
export async function handleAgentUserInput(
    target: AgentHost,
    question: string,
    choices?: string[],
    allowFreeform = true
): Promise<AgentUserInputResponse> {
    const resp = await target.requestUserInput(question, choices, allowFreeform);

    return { answer: resp.answer, wasFreeform: resp.wasFreeform };
}

// Build preview for content-field write tools (write_file etc.)
async function buildWritePreviewForWrite(toolArgs: unknown, workspacePath: string): Promise<ToolWritePreview | undefined> {
    const request = extractWriteRequest(toolArgs, workspacePath);
    if (!request) return undefined;

    const currentContent = await readFileOrEmpty(request.targetPath);
    const diff = await computeDiff(currentContent, request.nextContent);

    return {
        applyStrategy: 'content-field',
        contentField: request.contentField,
        currentContent,
        diff,
        displayPath: request.displayPath,
        proposedContent: request.nextContent,
        proposedEndsWithNewline: request.nextContent.endsWith('\n'),
    };
}

// Build preview for the kra-file-context anchor-based `edit` tool.
// Returns undefined if any anchor fails to resolve uniquely — the tool itself
// will reject the call with a detailed error, so the diff editor stays out of
// the way.
interface ResolvedAnchorEdit extends AnchorEdit {
    affectedStart: number;
    affectedEnd: number;
    insertAt?: number;
}

function findExactAnchor(haystack: string[], needle: string[]): number {
    const limit = haystack.length - needle.length;
    let found = -1;

    if (limit < 0) return -1;

    outer:
    for (let i = 0; i <= limit; i++) {
        for (let j = 0; j < needle.length; j++) {
            if (haystack[i + j] !== needle[j]) continue outer;
        }
        if (found !== -1) return -1;
        found = i;
    }

    return found;
}

function findTrimmedAnchor(haystack: string[], needle: string[]): number {
    const trimmedNeedle = needle.map(l => l.trim());
    const limit = haystack.length - needle.length;
    let found = -1;

    if (limit < 0) return -1;

    outer:
    for (let i = 0; i <= limit; i++) {
        for (let j = 0; j < needle.length; j++) {
            if (haystack[i + j].trim() !== trimmedNeedle[j]) continue outer;
        }
        if (found !== -1) return -1;
        found = i;
    }

    return found;
}

function resolveAnchorIndex(haystack: string[], anchorRaw: string): number {
    const needle = anchorRaw.replace(/\n+$/, '').split('\n');
    if (needle.length === 0 || needle.every(l => l.trim() === '')) return -1;
    const exact = findExactAnchor(haystack, needle);
    if (exact >= 0) return exact;

    return findTrimmedAnchor(haystack, needle);
}

async function buildWritePreviewForAnchorEdit(toolName: string, toolArgs: unknown, workspacePath: string): Promise<ToolWritePreview | undefined> {
    if (!isAnchorEditTool(toolName)) return undefined;

    const request = extractAnchorEditRequest(toolArgs, workspacePath);
    if (!request) return undefined;

    const currentContent = await readFileOrEmpty(request.targetPath);
    const lines = currentContent.split('\n');

    const resolved: ResolvedAnchorEdit[] = [];

    for (const e of request.edits) {
        const start = resolveAnchorIndex(lines, e.anchor);
        if (start < 0) return undefined;
        const anchorLineCount = e.anchor.replace(/\n+$/, '').split('\n').length;
        const anchorEnd = start + anchorLineCount - 1;

        let endAnchorEnd = anchorEnd;
        if (e.endAnchor) {
            const endStart = resolveAnchorIndex(lines, e.endAnchor);
            if (endStart < 0 || endStart < start) return undefined;
            const endLineCount = e.endAnchor.replace(/\n+$/, '').split('\n').length;
            endAnchorEnd = endStart + endLineCount - 1;
        }

        if (e.op === 'insert') {
            const insertAt = e.position === 'before' ? start : anchorEnd + 1;
            resolved.push({ ...e, affectedStart: insertAt, affectedEnd: insertAt - 1, insertAt });
        } else {
            resolved.push({ ...e, affectedStart: start, affectedEnd: endAnchorEnd });
        }
    }

    // Apply bottom-to-top.
    let working = lines;
    const order = [...resolved].sort((a, b) => b.affectedStart - a.affectedStart);
    for (const e of order) {
        const insertLines = e.op === 'delete' || e.content === '' || e.content === undefined
            ? []
            : e.content.split('\n');
        if (e.op === 'insert') {
            const at = e.insertAt as number;
            working = [...working.slice(0, at), ...insertLines, ...working.slice(at)];
        } else {
            working = [
                ...working.slice(0, e.affectedStart),
                ...insertLines,
                ...working.slice(e.affectedEnd + 1),
            ];
        }
    }

    const proposedContent = working.join('\n');
    const diff = await computeDiff(currentContent, proposedContent);
    const note = `Applies ${request.edits.length} anchor-based edit${request.edits.length === 1 ? '' : 's'}. Approved edits are applied as a full-file replacement.`;

    return {
        applyStrategy: 'edit-tool',
        currentContent,
        diff,
        displayPath: request.displayPath,
        note,
        proposedContent,
        proposedEndsWithNewline: proposedContent.endsWith('\n'),
    };
}

async function buildWritePreviewForEdit(toolArgs: unknown, workspacePath: string): Promise<ToolWritePreview | undefined> {
    const editRequest = extractEditRequest(toolArgs, workspacePath);
    if (!editRequest) return undefined;

    const currentContent = await readFileOrEmpty(editRequest.targetPath);
    let proposedContent = currentContent;
    let note = 'Approved edits will be converted into a full-file edit so they still apply reliably.';

    if (!editRequest.oldString) {
        if (!currentContent.length) {
            proposedContent = editRequest.newString;
            note = 'New file — the middle pane shows what will be written. Edit before approving.';
        } else {
            // Whole-file replacement (no old_str). Middle = full new content.
            proposedContent = editRequest.newString;
            note = 'No old_str supplied — the middle pane shows the full replacement. Edit before approving.';
        }
    } else if (editRequest.oldString === editRequest.newString) {
        proposedContent = currentContent;
        note = 'old_str and new_str are identical; approving keeps the file unchanged.';
    } else {
        const firstIndex = currentContent.indexOf(editRequest.oldString);
        const lastIndex = currentContent.lastIndexOf(editRequest.oldString);

        if (firstIndex !== -1 && firstIndex === lastIndex) {
            proposedContent = currentContent.replace(editRequest.oldString, editRequest.newString);
        } else if (firstIndex === -1) {
            if (!currentContent.length) {
                proposedContent = editRequest.newString;
                note = 'New file — the middle pane shows what will be written. Edit before approving.';
            } else {
                // old_str not in file — append as best-effort (same as yolo path).
                // Middle shows a full file so the diff doesn't look like "delete everything".
                proposedContent = `${currentContent}\n${editRequest.newString}`;
                note = 'old_str not found — change appended at end as best-effort. Edit the middle pane to place it correctly.';
            }
        } else {
            note = 'old_str appears multiple times — first occurrence replaced. Edit the middle pane if needed.';
            proposedContent = currentContent.replace(editRequest.oldString, editRequest.newString);
        }
    }

    const diff = await computeDiff(currentContent, proposedContent);

    return {
        applyStrategy: 'edit-tool',
        currentContent,
        diff,
        displayPath: editRequest.displayPath,
        note,
        proposedContent,
        proposedEndsWithNewline: proposedContent.endsWith('\n'),
    };
}

export async function buildWritePreview(toolName: string, toolArgs: unknown, workspacePath: string): Promise<ToolWritePreview | undefined> {
    return (
        await buildWritePreviewForWrite(toolArgs, workspacePath)
        ?? await buildWritePreviewForAnchorEdit(toolName, toolArgs, workspacePath)
        ?? await buildWritePreviewForEdit(toolArgs, workspacePath)
    );
}


// Builds a compact "File: ... / Line ranges: ..." summary for the file-context
// `read_lines` tool calls so the permission popup shows the
// targeted ranges at a glance instead of an opaque "Arguments:" placeholder.
function summarizeLineRanges(args: Record<string, unknown> | undefined): string | undefined {
    if (!args) return undefined;
    const filePath = typeof args.file_path === 'string' ? args.file_path : undefined;
    const startArr = coerceNumberArray(args.startLines);
    const endArr = coerceNumberArray(args.endLines);

    const ranges: Array<[number, number]> = [];
    if (startArr && endArr && startArr.length === endArr.length && startArr.length > 0) {
        for (let i = 0; i < startArr.length; i++) ranges.push([startArr[i], endArr[i]]);
    } else {
        const s = coerceNumber(args.start_line);
        const e = coerceNumber(args.end_line);
        if (s !== undefined && e !== undefined) ranges.push([s, e]);
    }

    if (!filePath && ranges.length === 0) return undefined;

    const out: string[] = [];
    if (filePath) out.push(`File: ${filePath}`);
    if (ranges.length > 0) {
        const total = ranges.reduce((acc, [s, e]) => acc + Math.max(0, e - s + 1), 0);
        const list = ranges
            .map(([s, e]) => (s === e ? `${s}` : `${s}\u2013${e}`))
            .join(', ');
        out.push(
            `Line ranges: ${list}  (${ranges.length} range${ranges.length === 1 ? '' : 's'}, ${total} line${total === 1 ? '' : 's'})`
        );
    }

    return out.join('\n');
}

export async function buildToolApprovalDetails(input: AgentPreToolUseHookInput, workspacePath: string): Promise<{
    argsJson: string,
    details: string,
    writePreview?: ToolWritePreview,
}> {
    // If toolArgs is already a JSON string (as sent by some SDK versions), use it
    // directly — re-encoding would double-escape it and break Lua's json.decode.
    const argsJson = typeof input.toolArgs === 'string'
        ? input.toolArgs
        : JSON.stringify(input.toolArgs ?? {}, null, 2);
    const argsRecord = getToolArgsRecord(input.toolArgs);
    const isLineRangeTool = input.toolName.includes('read_lines');
    const lineRangeSummary = isLineRangeTool ? summarizeLineRanges(argsRecord) : undefined;
    const summary = lineRangeSummary
        ?? (typeof argsRecord?.command === 'string'
            ? `Command:\n${argsRecord.command}`
            : typeof argsRecord?.query === 'string'
                ? `Query:\n${argsRecord.query}`
                : typeof argsRecord?.path === 'string'
                    ? `Path:\n${argsRecord.path}`
                    : 'Arguments:');
    const writePreview = await buildWritePreview(input.toolName, input.toolArgs, workspacePath);
    const sections = [
        `Tool: ${input.agentLabel ? `[${input.agentLabel}] ` : ''}${input.toolName}`,
        '',
        summary,
    ];

    if (writePreview) {
        sections.push(
            '',
            `Write target:\n${writePreview.displayPath}`,
            ...(writePreview.note ? ['', `Review note:\n${writePreview.note}`] : []),
            '',
            'Diff preview:',
            formatToolProgress(writePreview.diff || 'Open the diff editor to inspect the proposed change side by side.'),
            '',
            'Press e to inspect and edit the proposed write in a real diff view.'
        );
    }

    sections.push(
        '',
        typeof argsRecord?.command === 'string'
            ? 'Press e to review/edit this command before it runs.'
            : 'Press e to review/edit the actual tool arguments before approval.'
    );

    return writePreview
        ? {
            argsJson,
            details: sections.join('\n'),
            writePreview,
        }
        : {
            argsJson,
            details: sections.join('\n'),
        };
}


export async function promptToolApproval(
    target: AgentHost,
    input: AgentPreToolUseHookInput,
    workspacePath: string
): Promise<{ decision: ToolApprovalResult, preview: ToolWritePreview | undefined }> {
    const payload = await buildToolApprovalDetails(input, workspacePath);

    // Build the chat-modal payload directly from the agent's richer
    // approval details. The write preview's diff is already embedded in
    // `payload.details` by `buildToolApprovalDetails`, so the user can
    // review changes inline.
    const summary = (payload.details.split('\n')[2] ?? '').trim() || input.toolName;
    const modalPayload = {
        toolName: input.toolName,
        ...(input.agentLabel ? { agentLabel: input.agentLabel } : {}),
        title: `Approve tool · ${input.agentLabel ? `[${input.agentLabel}] ` : ''}${input.toolName}`,
        summary,
        details: payload.details,
        argsJson: payload.argsJson,
        toolArgs: input.toolArgs,
        ...(payload.writePreview ? { writePreview: payload.writePreview } : {}),
    };
    const decision = await target.requestApproval(modalPayload);
    const result: ToolApprovalResult = decision.action === 'allow'
        ? (decision.modifiedArgs !== undefined
            ? { action: 'allow', modifiedArgs: decision.modifiedArgs }
            : { action: 'allow' })
        : decision.action === 'allow-family'
            ? { action: 'allow-family' }
            : decision.action === 'yolo'
                ? { action: 'yolo' }
                : (decision.denyReason
                    ? { action: 'deny', denyReason: decision.denyReason }
                    : { action: 'deny' });

    return { decision: result, preview: payload.writePreview };
}

// str_replace and edit both invoke the same Dts handler in the CLI binary.
const EDIT_COMMANDS = new Set(['str_replace', 'edit']);

export async function applyStrReplaceEditorDirectly(
    input: AgentPreToolUseHookInput,
    workspacePath: string,
    userNewStr?: string,
    state?: AgentConversationState
): Promise<AgentPreToolUseHookOutput | undefined> {
    const EDIT_TOOL_NAMES = new Set(['str_replace_editor', 'edit']);

    if (!EDIT_TOOL_NAMES.has(input.toolName)) {
        return undefined;
    }

    const args = getToolArgsRecord(input.toolArgs);
    if (!args) {
        return undefined;
    }

    // 'command' may be omitted entirely for the standalone "edit" tool.
    // Fall back to 'create' when file_text is present, otherwise str_replace.
    const command = args.command ?? (typeof args.file_text === 'string' ? 'create' : 'str_replace');

    const rawPath = typeof args.path === 'string' ? args.path : undefined;
    if (!rawPath) {
        return undefined;
    }

    const filePath = path.isAbsolute(rawPath) ? rawPath : path.join(workspacePath, rawPath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    if (command === 'create') {
        const fileText = typeof args.file_text === 'string' ? args.file_text : '';
        const existingContent = await readFileOrEmpty(filePath);
        // Remove any existing file so the SDK's create handler doesn't error on "already exists".
        try { await fs.unlink(filePath); } catch { /* file may not exist */ }
        state?.history.recordMutation({
            path: filePath,
            beforeContent: existingContent || null,
            afterContent: fileText,
            source: 'str_replace_editor:create',
        });

        return { permissionDecision: 'allow', modifiedArgs: { ...args, file_text: fileText } };
    }

    if (!EDIT_COMMANDS.has(command as string)) {
        return undefined;
    }

    // Compute the desired final file content.
    let currentContent = '';
    try { currentContent = await fs.readFile(filePath, 'utf8'); } catch { /* new file */ }
    let finalContent: string;
    if (typeof userNewStr === 'string') {
        finalContent = userNewStr;
    } else {
        const oldStr = typeof args.old_str === 'string' ? args.old_str : '';
        const newStr = typeof args.new_str === 'string' ? args.new_str : '';
        if (oldStr && currentContent.includes(oldStr)) {
            finalContent = currentContent.replace(oldStr, newStr);
        } else {
            // old_str not found — agent has stale context; append the new content.
            finalContent = currentContent ? currentContent + '\n' + newStr : newStr;
        }
    }

    // Atomically write the final content ourselves, then return a no-op str_replace
    // (full-content match is trivially unique) so the SDK's handler succeeds without
    // mutating the file further.
    await atomicWriteFile(filePath, finalContent);
    state?.history.recordMutation({
        path: filePath,
        beforeContent: currentContent || null,
        afterContent: finalContent,
        source: 'str_replace_editor',
    });

    return {
        permissionDecision: 'allow',
        modifiedArgs: { ...args, old_str: finalContent, new_str: finalContent },
    };
}

export async function handleAskKra(
    state: AgentConversationState,
    input: AgentPreToolUseHookInput
): Promise<AgentPreToolUseHookOutput> {
    const args = getToolArgsRecord(input.toolArgs) ?? {};
    const summary = typeof args.summary === 'string' ? args.summary : 'Ready to hear from you.';
    const rawChoices = Array.isArray(args.choices) ? args.choices as unknown[] : [];
    const aiChoices = rawChoices.filter((c): c is string => typeof c === 'string');
    // Always append "End session" so the user has an explicit exit path.
    const choices = [...aiChoices, 'End session'];

    // Force-drain any prose still queued in the streaming pacer's pending
    // buffer first so the user sees ALL of the model's output up to this
    // point BEFORE the modal pops up. Otherwise the typewriter is mid-
    // sentence and the modal feels like it appeared out of nowhere.
    await state.flushPendingProse?.();

    // Close any in-flight ```thinking fence so the question/answer/header
    // we're about to write land at the top level of the transcript instead
    // of inside the still-open reasoning code block.
    state.closeReasoningFence?.();

    // Write the AI's question + choices into the chat file AND mirror it
    // into the TUI transcript before showing the popup, so the user sees
    // the same question in-line that gets persisted to the chat file.
    const questionBlock = formatConfirmQuestion(summary, choices);
    await appendToChat(state.chatFile, questionBlock);
    state.host.appendLine(questionBlock);

    const { answer } = await handleAgentUserInput(state.host, summary, choices, true);

    if (!answer || answer.trim() === '') {
        // Dismissed — deny so AI stays in the turn and can ask again.
        const dismissedBlock = formatConfirmAnswer('(dismissed)');
        await appendToChat(state.chatFile, dismissedBlock);
        state.host.appendLine(dismissedBlock);

        return {
            permissionDecision: 'deny',
            permissionDecisionReason: 'User dismissed the prompt without answering. Ask again or continue working.',
        };
    }

    // Write the user's answer + a fresh ASSISTANT header into the chat
    // file AND mirror them into the TUI transcript so the next streamed
    // chunks land under their own header instead of inside the previous
    // assistant block.
    const answerBlock = formatConfirmAnswer(answer);
    const assistantHeader = formatAssistantHeader(state.model);
    await appendToChat(state.chatFile, answerBlock);
    await appendToChat(state.chatFile, assistantHeader);
    state.host.appendLine(answerBlock);
    state.host.appendLine(assistantHeader);

    if (answer === 'End session') {
        // User is done — allow the tool so the AI ends the turn naturally.
        return { permissionDecision: 'allow' };
    }

    // User wants to continue — deny the tool so the AI stays in the same turn
    // (free, no extra credit) and acts on the user's reply.
    return {
        permissionDecision: 'deny',
        permissionDecisionReason: `User says: "${answer}". Continue based on this reply. Do not end your turn — call ask_kra again only when you need the user again.`,
    };
}

// Large-file threshold in lines — above this the agent gets an outline instead of raw content.
const LARGE_FILE_LINE_THRESHOLD = 300;

// Tool names (or name fragments) that do full file reads.
const FILE_READ_TOOLS = new Set(['read_file', 'view']);

export function extractFileReadPath(input: AgentPreToolUseHookInput, workspacePath: string): string | undefined {
    const args = getToolArgsRecord(input.toolArgs);
    if (!args) return undefined;

    const rawPath = typeof args.path === 'string'
        ? args.path
        : typeof args.file_path === 'string'
            ? args.file_path
            : typeof args.filename === 'string'
                ? args.filename
                : Array.isArray(args.paths) && typeof args.paths[0] === 'string'
                    ? args.paths[0]
                    : undefined;
    if (!rawPath) return undefined;

    // str_replace_editor doubles as a viewer — only intercept the 'view' command.
    if (input.toolName === 'str_replace_editor') {
        const command = typeof args.command === 'string' ? args.command : undefined;
        if (command !== 'view') return undefined;
    } else if (!FILE_READ_TOOLS.has(input.toolName)) {
        return undefined;
    }

    return path.isAbsolute(rawPath) ? rawPath : path.join(workspacePath, rawPath);
}

function toolNameMatches(toolName: string, expected: string): boolean {
    const lower = toolName.toLowerCase();

    return lower === expected
        || lower.endsWith(`:${expected}`)
        || lower.endsWith(`_${expected}`)
        || lower.endsWith(`-${expected}`);
}

function coerceStringList(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }

    const out = value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean);

    return out;
}

async function maybeInterceptMemoryRead(
    state: AgentConversationState,
    input: AgentPreToolUseHookInput,
): Promise<AgentPreToolUseHookOutput | undefined> {
    const args = getToolArgsRecord(input.toolArgs);

    if (!args) {
        return undefined;
    }

    if (toolNameMatches(input.toolName, 'recall')) {
        const kind = typeof args.kind === 'string' ? args.kind : undefined;

        if (!kind || !isMemoryLookupKind(kind)) {
            return undefined;
        }

        const candidateInput: Parameters<typeof recall>[0] = { kind };
        if (typeof args.query === 'string') candidateInput.query = args.query;
        if (typeof args.k === 'number') candidateInput.k = args.k;
        if (args.status === 'open' || args.status === 'resolved' || args.status === 'dismissed') candidateInput.status = args.status;
        const tagsAny = coerceStringList(args.tagsAny);
        if (tagsAny !== undefined) candidateInput.tagsAny = tagsAny;

        const candidates = await recall(candidateInput);
        if (candidates.length === 0) {
            return { permissionDecision: 'allow' };
        }

        const picked = await state.host.pickMemories(candidates, {
            title: kind === 'revisit' ? 'Select revisits for recall' : 'Select memories for recall',
        }) as typeof candidates | null;
        if (!picked || picked.length === 0) {
            return {
                permissionDecision: 'deny',
                permissionDecisionReason: 'No memories were selected. Continue without memory context and do not repeat this recall unless the user asks.',
            };
        }

        return {
            permissionDecision: 'allow',
            modifiedArgs: { ...args, selectedIds: picked.map((entry) => entry.id) },
            additionalContext: `User selected ${picked.length} ${picked.length === 1 ? 'memory' : 'memories'} from the picker. Use only the selected memory results below.`,
        };
    }

    if (toolNameMatches(input.toolName, 'semantic_search')) {
        const scope = typeof args.scope === 'string' ? args.scope : 'code';
        const memoryKind = typeof args.memoryKind === 'string' ? args.memoryKind : undefined;
        const query = typeof args.query === 'string' ? args.query.trim() : '';

        if ((scope !== 'memory' && scope !== 'both') || !memoryKind || !isMemoryLookupKind(memoryKind) || query.length === 0) {
            return undefined;
        }

        const candidateInput: Parameters<typeof semanticSearch>[0] = { query, scope: 'memory', memoryKind };
        if (typeof args.k === 'number') candidateInput.k = args.k;

        const candidates = (await semanticSearch(candidateInput))
            .flatMap((hit) => (hit.memory ? [hit.memory] : []));
        if (candidates.length === 0) {
            return { permissionDecision: 'allow' };
        }

        const picked = await state.host.pickMemories(candidates, {
            title: memoryKind === 'revisit' ? 'Select revisits for semantic search' : 'Select memories for semantic search',
        }) as typeof candidates | null;
        if (!picked || picked.length === 0) {
            return {
                permissionDecision: 'deny',
                permissionDecisionReason: 'No memories were selected. Continue without memory context and do not repeat this semantic search unless the user asks.',
            };
        }

        return {
            permissionDecision: 'allow',
            modifiedArgs: { ...args, selectedIds: picked.map((entry) => entry.id) },
            additionalContext: `User selected ${picked.length} ${picked.length === 1 ? 'memory' : 'memories'} from the picker. Use only the selected memory results below.`,
        };
    }

    return undefined;
}

export async function handlePreToolUse(
    state: AgentConversationState,
    input: AgentPreToolUseHookInput
): Promise<AgentPreToolUseHookOutput> {
    const toolFamily = getToolFamily(input.toolName);
    const workspacePath = state.cwd;

    // `ask_kra` can arrive as bare name or MCP-prefixed
    // (e.g. "kra-session-complete:ask_kra", or with underscores
    // depending on SDK version). Use includes() so any format matches.
    if (input.toolName.includes('ask_kra')) {
        return handleAskKra(state, input);
    }

    if (shouldAutoApproveTool(input.toolName)) {
        return { permissionDecision: 'allow' };
    }

    const memoryIntercept = await maybeInterceptMemoryRead(state, input);
    if (memoryIntercept) {
        return memoryIntercept;
    }

    // Intercept large file reads: return an outline and direct the model to the
    // kra-file-context tools (get_outline, read_lines, read_function) instead.
    const fileReadPath = extractFileReadPath(input, workspacePath);
    if (fileReadPath) {
        try {
            const outline = await getFileOutline(fileReadPath);
            if (outline.lineCount > LARGE_FILE_LINE_THRESHOLD) {
                return {
                    permissionDecision: 'deny',
                    permissionDecisionReason: [
                        `File has ${outline.lineCount} lines — reading it in full wastes context.`,
                        `Use the kra-file-context MCP tools instead:\n`,
                        formatOutline(fileReadPath, outline),
                        `\nAvailable tools: get_outline(file_path), read_lines(file_path, start_line, end_line) or read_lines(file_path, startLines, endLines), read_function(file_path, function_name)`,
                    ].join('\n'),
                };
            }
        } catch {
            // File unreadable or not a text file — let the tool proceed normally.
        }
    }

    // The anchor-based `edit` tool needs no upfront cap check — the replaced
    // region is bounded by content the agent named explicitly, so there is no
    // trust-based length to police here.
    // Snapshot git state before any bash-family tool runs for mutation tracking.
    const isBashLikeTool = ['bash', 'shell', 'execute', 'run_terminal', 'computer'].some(
        (fragment) => input.toolName.toLowerCase().includes(fragment)
    );
    if (isBashLikeTool) {
        try {
            state.pendingBashSnapshot = await state.history.bashSnapshotBefore();
        } catch { /* non-fatal */ }
    }

    // Pre-read file content for edit / create_file so we have an accurate
    // "before" snapshot in history regardless of approval mode.
    let preReadTargetPath: string | undefined;
    let preReadBeforeContent: string | undefined;
    if (isAnchorEditTool(input.toolName)) {
        const req = extractAnchorEditRequest(input.toolArgs, workspacePath);
        if (req?.targetPath) {
            preReadTargetPath = req.targetPath;
            preReadBeforeContent = await readFileOrEmpty(req.targetPath);
        }
    } else if (input.toolName.includes('create_file')) {
    } else if (input.toolName.includes('create_file')) {
        const cfArgs = getToolArgsRecord(input.toolArgs);
        const rawCfPath = typeof cfArgs?.file_path === 'string' ? cfArgs.file_path : undefined;
        if (rawCfPath) {
            preReadTargetPath = path.isAbsolute(rawCfPath) ? rawCfPath : path.join(workspacePath, rawCfPath);
            preReadBeforeContent = await readFileOrEmpty(preReadTargetPath);
        }
    }

    if (state.approvalMode === 'yolo' || state.allowedToolFamilies.has(toolFamily)) {
        if (preReadTargetPath !== undefined && preReadBeforeContent !== undefined) {
            const cfArgs = input.toolName.includes('create_file') ? getToolArgsRecord(input.toolArgs) : undefined;
            state.history.recordMutation({
                path: preReadTargetPath,
                beforeContent: preReadBeforeContent || null,
                afterContent: cfArgs && typeof cfArgs.content === 'string' ? cfArgs.content : null,
                source: isAnchorEditTool(input.toolName) ? 'edit' : 'create_file',
            });
        }

        return (await applyStrReplaceEditorDirectly(input, workspacePath, undefined, state)) ?? { permissionDecision: 'allow' };
    }

    // Drain any prose still queued in the streaming pacer before the
    // approval modal pops up so the user has full context (the model
    // often writes "I'll now ..." right before the tool call). Without
    // this drain the modal appears mid-typewriter and the prose only
    // arrives AFTER the user answers, which is jarring.
    await state.flushPendingProse?.();

    const { decision, preview } = await promptToolApproval(state.host, input, workspacePath);

    if (decision.action === 'allow-family') {
        state.allowedToolFamilies.add(toolFamily);
    } else if (decision.action === 'yolo') {
        state.approvalMode = 'yolo';
    }

    if (decision.action === 'deny') {
        const baseReason = 'Denied by user. Do not retry this tool call. Call ask_kra immediately to explain what you were trying to do and ask the user what they want instead.';
        const reason = decision.denyReason
            ? `User denied this tool call with reason: "${decision.denyReason}". Treat the user's reason as authoritative direction and follow it. Only call ask_kra if you need more information to proceed.`
            : baseReason;

        return {
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
        };
    }

    // For str_replace_editor: write the file ourselves so the SDK never has to match
    // old_str against disk — a mismatch-prone operation.  The diff-editor path puts
    // the user-approved final content in modifiedArgs.new_str; all other paths let
    // applyStrReplaceEditorDirectly reapply the agent's intended replacement.
    const modifiedArgs = decision.modifiedArgs as Record<string, unknown> | undefined;
    const userNewStr = typeof modifiedArgs?.new_str === 'string' ? modifiedArgs.new_str : undefined;
    const strReplaceResult = await applyStrReplaceEditorDirectly(input, workspacePath, userNewStr, state);
    if (strReplaceResult) {
        return strReplaceResult;
    }

    // For content-field write tools (write_file etc.) approved via diff editor, keep
    // modifiedArgs so the SDK receives the user-reviewed content.
    if (preview?.applyStrategy === 'content-field' && modifiedArgs) {
        return { permissionDecision: 'allow', modifiedArgs };
    }

    // For kra-file-context create_file: record the mutation before MCP applies it.
    if (input.toolName.includes('create_file') && preReadTargetPath !== undefined && preReadBeforeContent !== undefined) {
        const cfArgs = getToolArgsRecord(input.toolArgs);
        state.history.recordMutation({
            path: preReadTargetPath,
            beforeContent: preReadBeforeContent || null,
            afterContent: typeof cfArgs?.content === 'string' ? cfArgs.content : '',
            source: 'create_file',
        });
    }

    // For the anchor-based `edit` tool: honour user edits from the diff editor
    // by writing the user's final content directly, then short-circuit MCP with
    // a no-op edit (anchor = entire file == content). Otherwise just record the
    // before/after mutation and let the MCP server apply the agent's args.
    if (isAnchorEditTool(input.toolName) && preview?.applyStrategy === 'edit-tool') {
        if (preReadTargetPath !== undefined && preReadBeforeContent !== undefined) {
            const userFinalContent = typeof modifiedArgs?.__userFinalContent === 'string'
                ? modifiedArgs.__userFinalContent : undefined;

            if (userFinalContent !== undefined) {
                const notifyAgent = modifiedArgs?.__userEditNotify === true;

                await atomicWriteFile(preReadTargetPath, userFinalContent);
                state.history.recordMutation({
                    path: preReadTargetPath,
                    beforeContent: preReadBeforeContent || null,
                    afterContent: userFinalContent,
                    source: 'edit:user',
                });

                // Send a no-op edit to MCP so it still runs LSP diagnostics on
                // the saved file and reports them back to the agent. The whole
                // file is trivially a unique anchor, and replacing it with
                // itself is a safe no-op since we already wrote the desired
                // final content above.
                const args = getToolArgsRecord(input.toolArgs) ?? {};
                const newArgs: Record<string, unknown> = { ...args };
                delete newArgs.__userFinalContent;
                delete newArgs.__userEditNotify;
                newArgs.edits = [{ op: 'replace', anchor: userFinalContent, content: userFinalContent }];

                let context: string;
                if (notifyAgent) {
                    const previewLines = userFinalContent.split('\n');
                    const head = previewLines.slice(0, 80)
                        .map((l, i) => `${i + 1}: ${l}`)
                        .join('\n');
                    const tail = previewLines.length > 80 ? `\n... (${previewLines.length - 80} more lines)` : '';

                    context =
                        `The user reviewed your proposed edit in the diff editor and adjusted it before applying. ` +
                        `${preReadTargetPath} now contains the user's final version. First lines:\n${head}${tail}`;
                } else {
                    context =
                        `The user reviewed your proposed edit in the diff editor and adjusted it before applying. ` +
                        `${preReadTargetPath} now contains the user's final version. They chose not to surface ` +
                        `the exact post-edit lines — assume the change is fine if no LSP diagnostics were ` +
                        `reported by the tool result. Only call read_lines if you specifically need to inspect ` +
                        `the new content.`;
                }

                return {
                    permissionDecision: 'allow',
                    modifiedArgs: newArgs,
                    additionalContext: context,
                };
            }

            state.history.recordMutation({
                path: preReadTargetPath,
                beforeContent: preReadBeforeContent || null,
                afterContent: preview.proposedContent,
                source: 'edit',
            });
        }

        return { permissionDecision: 'allow' };
    }


    if (decision.modifiedArgs) {
        return { permissionDecision: 'allow', modifiedArgs: decision.modifiedArgs };
    }

    return { permissionDecision: 'allow' };
}

