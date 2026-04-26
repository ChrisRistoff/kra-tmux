import * as fs from 'fs/promises';
import os from 'os';
import path from 'path';
import * as neovim from 'neovim';
import type { VimValue } from 'neovim/lib/types/VimValue';
import {
    coerceNumber,
    coerceNumberArray,
    extractEditLinesRequest,
    extractEditRequest,
    extractWriteRequest,
    getToolArgsRecord,
    getToolFamily,
    shouldAutoApproveTool,
} from '@/AI/AIAgent/shared/utils/agentToolApproval';
import {
    formatAgentConversationEntry,
    formatConfirmAnswer,
    formatConfirmQuestion,
    formatToolProgress,
} from '@/AI/AIAgent/shared/utils/agentUi';
import { getFileOutline, formatOutline } from '@/AI/AIAgent/shared/utils/fileOutline';
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

const EDIT_LINES_HARD_CAP = 100;

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

export async function handleAgentUserInput(
    nvimClient: neovim.NeovimClient,
    question: string,
    choices?: string[],
    allowFreeform = true
): Promise<AgentUserInputResponse> {
    const channelId = await nvimClient.channelId;

    return new Promise<AgentUserInputResponse>((resolve) => {
        const handler = (method: string, args: unknown[]): void => {
            if (method !== 'user_input_response') {
                return;
            }

            nvimClient.removeListener('notification', handler);
            const answer = typeof args[0] === 'string' ? args[0] : '';
            const wasFreeform = args[1] === true || !choices?.includes(answer);
            resolve({ answer, wasFreeform });
        };

        nvimClient.on('notification', handler);

        void nvimClient.executeLua(
            `require('kra_agent_ui').request_user_input(...)`,
            [channelId, question, choices ?? [], allowFreeform] as VimValue[]
        ).catch(() => {
            nvimClient.removeListener('notification', handler);
            resolve({ answer: '', wasFreeform: true });
        });
    });
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

// Build preview for the edit_lines MCP tool (single- or multi-edit form).
async function buildWritePreviewForEditLines(toolArgs: unknown, workspacePath: string): Promise<ToolWritePreview | undefined> {
    const request = extractEditLinesRequest(toolArgs, workspacePath);
    if (!request) return undefined;

    const currentContent = await readFileOrEmpty(request.targetPath);
    let proposedContent: string;
    let note: string;

    if (request.startLines && request.endLines && request.newContents) {
        // Multi-edit (array) form — apply edits bottom-to-top, same as the MCP server.
        const { startLines, endLines, newContents } = request;
        let lines = currentContent.split('\n');
        const indices = Array.from({ length: startLines.length }, (_, i) => i)
            .sort((a, b) => startLines[b] - startLines[a]);

        for (const i of indices) {
            const start = startLines[i];
            const clampedEnd = Math.min(endLines[i], lines.length);
            const insertLines = newContents[i] === '' ? [] : newContents[i].split('\n');
            lines = [...lines.slice(0, start - 1), ...insertLines, ...lines.slice(clampedEnd)];
        }

        proposedContent = lines.join('\n');
        note = `Applies ${startLines.length} edit${startLines.length === 1 ? '' : 's'} across the file. Approved edits are applied as a full-file replacement.`;
    } else if (
        typeof request.startLine === 'number'
        && typeof request.endLine === 'number'
        && typeof request.newContent === 'string'
    ) {
        const { startLine, endLine, newContent } = request;
        const lines = currentContent.split('\n');
        const clampedEnd = Math.min(endLine, lines.length);
        const insertLines = newContent === '' ? [] : newContent.split('\n');
        const resultLines = [
            ...lines.slice(0, startLine - 1),
            ...insertLines,
            ...lines.slice(clampedEnd),
        ];
        proposedContent = resultLines.join('\n');
        note = newContent === ''
            ? `Deletes lines ${startLine}–${clampedEnd}. Edit the middle pane before approving.`
            : `Replaces lines ${startLine}–${clampedEnd} with ${insertLines.length} line${insertLines.length === 1 ? '' : 's'}. Approved edits are applied as a full-file replacement.`;
    } else {
        return undefined;
    }


    const diff = await computeDiff(currentContent, proposedContent);

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

export async function buildWritePreview(toolArgs: unknown, workspacePath: string): Promise<ToolWritePreview | undefined> {
    return (
        await buildWritePreviewForWrite(toolArgs, workspacePath)
        ?? await buildWritePreviewForEditLines(toolArgs, workspacePath)
        ?? await buildWritePreviewForEdit(toolArgs, workspacePath)
    );
}


// Builds a compact "File: ... / Line ranges: ..." summary for the file-context
// `read_lines` and `edit_lines` tool calls so the permission popup shows the
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
    const isLineRangeTool = input.toolName.includes('read_lines') || input.toolName.includes('edit_lines');
    const lineRangeSummary = isLineRangeTool ? summarizeLineRanges(argsRecord) : undefined;
    const summary = lineRangeSummary
        ?? (typeof argsRecord?.command === 'string'
            ? `Command:\n${argsRecord.command}`
            : typeof argsRecord?.query === 'string'
                ? `Query:\n${argsRecord.query}`
                : typeof argsRecord?.path === 'string'
                    ? `Path:\n${argsRecord.path}`
                    : 'Arguments:');
    const writePreview = await buildWritePreview(input.toolArgs, workspacePath);
    const sections = [
        `Tool: ${input.toolName}`,
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

async function writePreviewToTempFiles(preview: ToolWritePreview): Promise<{
    currentPath: string,
    proposedPath: string,
}> {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const currentPath = path.join(os.tmpdir(), `kra-agent-diff-current-${suffix}`);
    const proposedPath = path.join(os.tmpdir(), `kra-agent-diff-proposed-${suffix}`);

    await fs.writeFile(currentPath, preview.currentContent, 'utf8');
    await fs.writeFile(proposedPath, preview.proposedContent, 'utf8');

    return { currentPath, proposedPath };
}

export async function promptToolApproval(
    nvimClient: neovim.NeovimClient,
    input: AgentPreToolUseHookInput,
    workspacePath: string
): Promise<{ decision: ToolApprovalResult, preview: ToolWritePreview | undefined }> {
    const channelId = await nvimClient.channelId;
    const payload = await buildToolApprovalDetails(input, workspacePath);
    let tempFiles: { currentPath: string, proposedPath: string } | undefined;

    if (payload.writePreview) {
        tempFiles = await writePreviewToTempFiles(payload.writePreview);
    }

    const decision = await new Promise<ToolApprovalResult>((resolve) => {
        const cleanup = async (): Promise<void> => {
            if (tempFiles) {
                await fs.rm(tempFiles.currentPath, { force: true });
                await fs.rm(tempFiles.proposedPath, { force: true });
            }
        };

        const handler = (method: string, args: unknown[]): void => {
            if (method !== 'tool_permission_decision') {
                return;
            }

            nvimClient.removeListener('notification', handler);
            void cleanup();

            const action = args[0];
            const modifiedArgsJson = args[1];

            if (action === 'edited' && typeof modifiedArgsJson === 'string') {
                resolve({
                    action: 'allow',
                    modifiedArgs: JSON.parse(modifiedArgsJson),
                });

                return;
            }

            if (action === 'allow-family' || action === 'yolo' || action === 'allow') {
                resolve({ action: action as ToolApprovalResult['action'] });

                return;
            }

            resolve({ action: 'deny' });
        };

        nvimClient.on('notification', handler);

        void nvimClient.executeLua(`require('kra_agent_ui').request_permission(...)`, [
            channelId,
            {
                details: payload.details,
                title: `Approve tool · ${input.toolName}`,
                toolName: input.toolName,
                argsJson: payload.argsJson,
                hasWritePreview: !!payload.writePreview,
                previewCurrentPath: tempFiles?.currentPath,
                previewProposedPath: tempFiles?.proposedPath,
                previewDisplayPath: payload.writePreview?.displayPath,
                previewApplyStrategy: payload.writePreview?.applyStrategy,
                previewEndsWithNewline: payload.writePreview?.proposedEndsWithNewline,
                previewNote: payload.writePreview?.note,
            } satisfies Record<string, unknown> as unknown as VimValue,
        ]).catch(() => {
            nvimClient.removeListener('notification', handler);
            void cleanup();
            resolve({ action: 'deny' });
        });
    });

    return { decision, preview: payload.writePreview };
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

export async function handleConfirmTaskComplete(
    state: AgentConversationState,
    input: AgentPreToolUseHookInput
): Promise<AgentPreToolUseHookOutput> {
    const args = getToolArgsRecord(input.toolArgs) ?? {};
    const summary = typeof args.summary === 'string' ? args.summary : 'Ready to hear from you.';
    const rawChoices = Array.isArray(args.choices) ? args.choices as unknown[] : [];
    const aiChoices = rawChoices.filter((c): c is string => typeof c === 'string');
    // Always append "End session" so the user has an explicit exit path.
    const choices = [...aiChoices, 'End session'];

    // Write the AI's question + choices into the chat file before showing the popup.
    await appendToChat(state.chatFile, formatConfirmQuestion(summary, choices));
    try { await state.nvim.command('edit!'); } catch { /* nvim busy */ }
    try { await state.nvim.command('redraw!'); } catch { /* nvim busy */ }

    const { answer } = await handleAgentUserInput(state.nvim, summary, choices, true);

    if (!answer || answer.trim() === '') {
        // Dismissed — deny so AI stays in the turn and can ask again.
        await appendToChat(state.chatFile, formatConfirmAnswer('(dismissed)'));

        return {
            permissionDecision: 'deny',
            permissionDecisionReason: 'User dismissed the prompt without answering. Ask again or continue working.',
        };
    }

    // Write the user's answer into the chat file.
    await appendToChat(state.chatFile, formatConfirmAnswer(answer));
    // Write a new ASSISTANT header so the AI's continuation is visually separated.
    await appendToChat(state.chatFile, formatAgentConversationEntry('ASSISTANT', { model: state.model }));
    try { await state.nvim.command('edit!'); } catch { /* nvim busy */ }
    try { await state.nvim.command('redraw!'); } catch { /* nvim busy */ }

    if (answer === 'End session') {
        // User is done — allow the tool so the AI ends the turn naturally.
        return { permissionDecision: 'allow' };
    }

    // User wants to continue — deny the tool so the AI stays in the same turn
    // (free, no extra credit) and acts on the user's reply.
    return {
        permissionDecision: 'deny',
        permissionDecisionReason: `User says: "${answer}". Continue based on this reply. Do not end your turn — call confirm_task_complete again only when you need the user again.`,
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

export async function handlePreToolUse(
    state: AgentConversationState,
    input: AgentPreToolUseHookInput
): Promise<AgentPreToolUseHookOutput> {
    const toolFamily = getToolFamily(input.toolName);
    const workspacePath = state.cwd;

    // `confirm_task_complete` can arrive as bare name or MCP-prefixed
    // (e.g. "kra-session-complete:confirm_task_complete", or with underscores
    // depending on SDK version). Use includes() so any format matches.
    if (input.toolName.includes('confirm_task_complete')) {
        return handleConfirmTaskComplete(state, input);
    }

    if (shouldAutoApproveTool(input.toolName)) {
        return { permissionDecision: 'allow' };
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

    // Upfront cap check for edit_lines: reject ranges >100 lines BEFORE building
    // the diff or asking for approval. Saves the round-trip and gives the agent
    // an actionable error in one turn (with concrete split suggestions).
    if (input.toolName.includes('edit_lines')) {
        const editReq = extractEditLinesRequest(input.toolArgs, workspacePath);
        if (editReq) {
            const starts = editReq.startLines ?? (editReq.startLine !== undefined ? [editReq.startLine] : []);
            const ends = editReq.endLines ?? (editReq.endLine !== undefined ? [editReq.endLine] : []);
            const violations: string[] = [];
            for (let i = 0; i < starts.length; i++) {
                const span = ends[i] - starts[i] + 1;
                if (span > EDIT_LINES_HARD_CAP) {
                    const where = starts.length > 1 ? ` (range ${i})` : '';
                    const splitCount = Math.ceil(span / EDIT_LINES_HARD_CAP);
                    violations.push(`${starts[i]}–${ends[i]} = ${span} lines${where}; split into ${splitCount} ranges of <=${EDIT_LINES_HARD_CAP} lines each`);
                }
            }
            if (violations.length > 0) {
                return {
                    permissionDecision: 'deny',
                    permissionDecisionReason: [
                        `edit_lines hard cap is ${EDIT_LINES_HARD_CAP} lines per range. The following range(s) exceed it:`,
                        ...violations.map(v => `  - ${v}`),
                        '',
                        'Use the multi-edit form (startLines/endLines/newContents arrays) so non-overlapping regions go in a single call.',
                        'For a near-total file rewrite, split into multiple non-overlapping ranges that each cover <=100 lines of the original file.',
                        'Do NOT attempt to bypass this cap.',
                    ].join('\n'),
                };
            }
        }
    }
    // Snapshot git state before any bash-family tool runs for mutation tracking.
    const isBashLikeTool = ['bash', 'shell', 'execute', 'run_terminal', 'computer'].some(
        (fragment) => input.toolName.toLowerCase().includes(fragment)
    );
    if (isBashLikeTool) {
        try {
            state.pendingBashSnapshot = await state.history.bashSnapshotBefore();
        } catch { /* non-fatal */ }
    }

    // Pre-read file content for edit_lines / create_file so we have an accurate
    // "before" snapshot in history regardless of approval mode.
    let preReadTargetPath: string | undefined;
    let preReadBeforeContent: string | undefined;
    if (input.toolName.includes('edit_lines')) {
        const req = extractEditLinesRequest(input.toolArgs, workspacePath);
        if (req?.targetPath) {
            preReadTargetPath = req.targetPath;
            preReadBeforeContent = await readFileOrEmpty(req.targetPath);
        }
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
                source: input.toolName.includes('edit_lines') ? 'edit_lines' : 'create_file',
            });
        }

        return (await applyStrReplaceEditorDirectly(input, workspacePath, undefined, state)) ?? { permissionDecision: 'allow' };
    }

    const { decision, preview } = await promptToolApproval(state.nvim, input, workspacePath);

    if (decision.action === 'allow-family') {
        state.allowedToolFamilies.add(toolFamily);
    } else if (decision.action === 'yolo') {
        state.approvalMode = 'yolo';
    }

    if (decision.action === 'deny') {
        return {
            permissionDecision: 'deny',
            permissionDecisionReason: 'Denied by user. Do not retry this tool call. Call confirm_task_complete immediately to explain what you were trying to do and ask the user what they want instead.',
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

    // For edit_lines: honour user edits from the diff editor, or record the
    // before/after mutation and let the MCP server apply the agent's args.
    if (input.toolName.includes('edit_lines') && preview?.applyStrategy === 'edit-tool') {
        if (preReadTargetPath !== undefined && preReadBeforeContent !== undefined) {
            const userFinalContent = typeof modifiedArgs?.__userFinalContent === 'string'
                ? modifiedArgs.__userFinalContent : undefined;
            if (userFinalContent !== undefined) {
                state.history.recordMutation({
                    path: preReadTargetPath,
                    beforeContent: preReadBeforeContent || null,
                    afterContent: userFinalContent,
                    source: 'edit_lines:user',
                });

                // Transform the agent's edit_lines call into one that takes
                // the file from preReadBeforeContent to userFinalContent. We
                // strip the common prefix/suffix to find the changed region,
                // then encode it as one (or more, if >100 lines) edit_lines
                // ranges. MCP applies the edit, runs LSP diagnostics, and
                // reports the actual line changes back to the agent. Whether
                // the agent sees the new content or a brief notice depends on
                // the user's choice in the diff editor (__userEditNotify).
                const notifyAgent = modifiedArgs?.__userEditNotify === true;
                const beforeLines = preReadBeforeContent.split('\n');
                const afterLines = userFinalContent.split('\n');
                let cp = 0;
                const maxCommon = Math.min(beforeLines.length, afterLines.length);
                while (cp < maxCommon && beforeLines[cp] === afterLines[cp]) cp++;
                let cs = 0;
                while (
                    cs < maxCommon - cp
                    && beforeLines[beforeLines.length - 1 - cs] === afterLines[afterLines.length - 1 - cs]
                ) cs++;

                const editStart = cp + 1;
                const editEnd = Math.max(beforeLines.length - cs, cp);
                const newSliceStart = cp;
                const newSliceEnd = afterLines.length - cs;
                const newAfterStart = cp + 1;
                const newAfterEnd = afterLines.length - cs;

                const newStarts: number[] = [];
                const newEnds: number[] = [];
                const newContents: string[] = [];

                if (editEnd < editStart) {
                    const safeLine = Math.min(Math.max(editStart, 1), Math.max(beforeLines.length, 1));
                    const original = beforeLines[safeLine - 1] ?? '';
                    const inserted = afterLines.slice(newSliceStart, newSliceEnd).join('\n');
                    newStarts.push(safeLine);
                    newEnds.push(safeLine);
                    newContents.push(inserted ? `${original}\n${inserted}` : original);
                } else {
                    const beforeSpan = editEnd - editStart + 1;
                    if (beforeSpan <= EDIT_LINES_HARD_CAP) {
                        newStarts.push(editStart);
                        newEnds.push(editEnd);
                        newContents.push(afterLines.slice(newSliceStart, newSliceEnd).join('\n'));
                    } else {
                        // Split into ≤100-line ranges in the BEFORE file. MCP
                        // applies bottom-to-top, so each range's start/end
                        // refer to original line numbers. Distribute the
                        // after-side lines proportionally; the last chunk
                        // soaks up any leftover lines.
                        const chunkCount = Math.ceil(beforeSpan / EDIT_LINES_HARD_CAP);
                        const newRegionLines = afterLines.slice(newSliceStart, newSliceEnd);
                        const newPerChunk = Math.floor(newRegionLines.length / chunkCount);
                        let consumedBefore = 0;
                        let consumedAfter = 0;
                        for (let c = 0; c < chunkCount; c++) {
                            const isLast = c === chunkCount - 1;
                            const chunkBefore = isLast
                                ? beforeSpan - consumedBefore
                                : Math.min(EDIT_LINES_HARD_CAP, beforeSpan - consumedBefore);
                            const chunkAfter = isLast
                                ? newRegionLines.length - consumedAfter
                                : newPerChunk;
                            const s = editStart + consumedBefore;
                            const e = s + chunkBefore - 1;
                            const slice = newRegionLines.slice(consumedAfter, consumedAfter + chunkAfter).join('\n');
                            newStarts.push(s);
                            newEnds.push(e);
                            newContents.push(slice);
                            consumedBefore += chunkBefore;
                            consumedAfter += chunkAfter;
                        }
                    }
                }

                const args = getToolArgsRecord(input.toolArgs) ?? {};
                const useMulti = Array.isArray(args.startLines) || newStarts.length > 1;
                const newArgs: Record<string, unknown> = { ...args };
                delete newArgs.__userFinalContent;
                delete newArgs.__userEditNotify;
                if (useMulti) {
                    newArgs.startLines = newStarts;
                    newArgs.endLines = newEnds;
                    newArgs.newContents = newContents;
                    delete newArgs.start_line;
                    delete newArgs.end_line;
                    delete newArgs.new_content;
                } else {
                    newArgs.start_line = newStarts[0];
                    newArgs.end_line = newEnds[0];
                    newArgs.new_content = newContents[0];
                    delete newArgs.startLines;
                    delete newArgs.endLines;
                    delete newArgs.newContents;
                }

                let context: string;
                if (notifyAgent) {
                    const affectedAfterLines = afterLines.slice(newSliceStart, newSliceEnd);
                    let previewText: string;
                    let rangeLabel: string;
                    if (affectedAfterLines.length === 0) {
                        previewText = '(the affected region is now empty)';
                        rangeLabel = `near line ${newAfterStart}`;
                    } else {
                        previewText = affectedAfterLines
                            .map((l, i) => `${newAfterStart + i}: ${l}`)
                            .join('\n');
                        rangeLabel = `lines ${newAfterStart}\u2013${newAfterEnd}`;
                    }
                    context =
                        `The user reviewed your proposed edit in the diff editor and adjusted it before applying. ` +
                        `${preReadTargetPath} now contains the user's final version. The post-edit content of the ` +
                        `affected region (${rangeLabel}) is:\n${previewText}`;
                } else {
                    context =
                        `The user reviewed your proposed edit in the diff editor and adjusted it before applying. ` +
                        `${preReadTargetPath} now contains the user's final version. They chose not to surface ` +
                        `the exact post-edit lines \u2014 assume the change is fine if no LSP diagnostics were ` +
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
                source: 'edit_lines',
            });
        }

        return { permissionDecision: 'allow' };
    }

    if (decision.modifiedArgs) {
        return { permissionDecision: 'allow', modifiedArgs: decision.modifiedArgs };
    }

    return { permissionDecision: 'allow' };
}
