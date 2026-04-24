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
} from '@/AI/AIAgent/utils/agentToolApproval';
import {
    formatAgentConversationEntry,
    formatConfirmAnswer,
    formatConfirmQuestion,
    formatToolProgress,
} from '@/AI/AIAgent/utils/agentUi';
import { getFileOutline, formatOutline } from '@/AI/AIAgent/utils/fileOutline';
import * as bash from '@/utils/bashHelper';
import type {
    AgentConversationState,
    AgentPreToolUseHookInput,
    AgentPreToolUseHookOutput,
    AgentUserInputResponse,
    ToolApprovalResult,
    ToolWritePreview,
} from '@/AI/AIAgent/types/agentTypes';
import { atomicWriteFile } from '@/AI/AIAgent/utils/fileSafety';

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
        const handler = (method: string, args: unknown[]) => {
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
    } else {
        const lines = currentContent.split('\n');
        const clampedEnd = Math.min(request.endLine!, lines.length);
        const insertLines = request.newContent! === '' ? [] : request.newContent!.split('\n');
        const resultLines = [
            ...lines.slice(0, request.startLine! - 1),
            ...insertLines,
            ...lines.slice(clampedEnd),
        ];
        proposedContent = resultLines.join('\n');
        note = request.newContent! === ''
            ? `Deletes lines ${request.startLine}–${clampedEnd}. Edit the middle pane before approving.`
            : `Replaces lines ${request.startLine}–${clampedEnd} with ${insertLines.length} line${insertLines.length === 1 ? '' : 's'}. Approved edits are applied as a full-file replacement.`;
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
            } as VimValue,
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
    userNewStr?: string
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
        // Remove any existing file so the SDK's create handler doesn't error on "already exists".
        try { await fs.unlink(filePath); } catch { /* file may not exist */ }

        return { permissionDecision: 'allow', modifiedArgs: { ...args, file_text: fileText } };
    }

    if (!EDIT_COMMANDS.has(command as string)) {
        return undefined;
    }

    // Compute the desired final file content.
    let finalContent: string;
    if (typeof userNewStr === 'string') {
        finalContent = userNewStr;
    } else {
        const oldStr = typeof args.old_str === 'string' ? args.old_str : '';
        const newStr = typeof args.new_str === 'string' ? args.new_str : '';
        let current = '';
        try { current = await fs.readFile(filePath, 'utf8'); } catch { /* new file */ }

        if (oldStr && current.includes(oldStr)) {
            finalContent = current.replace(oldStr, newStr);
        } else {
            // old_str not found — agent has stale context; append the new content.
            finalContent = current ? current + '\n' + newStr : newStr;
        }
    }

    // Atomically write the final content ourselves, then return a no-op str_replace
    // (full-content match is trivially unique) so the SDK's handler succeeds without
    // mutating the file further. This avoids the previous truncate-then-rely-on-SDK
    // approach, which left the file empty between syscalls if the SDK call failed.
    await atomicWriteFile(filePath, finalContent);

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
    const workspacePath = state.proposalWorkspace.workspacePath;

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

    if (state.approvalMode === 'yolo' || state.allowedToolFamilies.has(toolFamily)) {
        return (await applyStrReplaceEditorDirectly(input, workspacePath)) ?? { permissionDecision: 'allow' };
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
    const strReplaceResult = await applyStrReplaceEditorDirectly(input, workspacePath, userNewStr);
    if (strReplaceResult) {
        return strReplaceResult;
    }

    // For content-field write tools (write_file etc.) approved via diff editor, keep
    // modifiedArgs so the SDK receives the user-reviewed content.
    if (preview?.applyStrategy === 'content-field' && modifiedArgs) {
        return { permissionDecision: 'allow', modifiedArgs };
    }

    // For edit_lines: if the user edited the diff, we'd want to apply that final
    // content. But the MCP server's 100-line cap and read-tracking gate are
    // intentionally absolute (no override). The upfront size check earlier in
    // this function rejects oversized edit_lines BEFORE the diff opens, so by
    // this point we know the agent's args are within the cap. Editing the diff
    // beyond the original line range is not supported — accept the agent's
    // original args (the user has at least seen the diff) and let MCP apply.
    if (input.toolName.includes('edit_lines') && preview?.applyStrategy === 'edit-tool') {
        return { permissionDecision: 'allow' };
    }

    if (decision.modifiedArgs) {
        return { permissionDecision: 'allow', modifiedArgs: decision.modifiedArgs };
    }

    return { permissionDecision: 'allow' };
}
