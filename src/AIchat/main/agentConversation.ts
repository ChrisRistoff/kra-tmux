import * as fs from 'fs/promises';
import os from 'os';
import path from 'path';
import * as neovim from 'neovim';
import type { VimValue } from 'neovim/lib/types/VimValue';
import { CopilotClient, type CopilotSession, type MessageOptions } from '@github/copilot-sdk';
import { aiRoles } from '@/AIchat/data/roles';
import { getConfiguredMcpServers } from '@/AIchat/utils/agentSettings';
import { buildAgentTmuxCommand } from '@/AIchat/utils/agentTmux';
import {
    extractEditLinesRequest,
    extractEditRequest,
    extractWriteRequest,
    getToolArgsRecord,
    getToolFamily,
    shouldAutoApproveTool,
} from '@/AIchat/utils/agentToolApproval';
import {
    extractAgentDraftPrompt,
    formatAgentConversationEntry,
    formatAgentDraftEntry,
    formatToolArguments,
    formatToolCompletion,
    formatToolDisplayName,
    formatToolProgress,
    formatToolLine,
    formatConfirmQuestion,
    formatConfirmAnswer,
    materializeAgentDraft,
    isAgentDraftHeader,
    isAgentUserHeader,
    summarizeToolCall,
} from '@/AIchat/utils/agentUi';
import {
    applyProposalToRepo,
    createProposalWorkspace,
    hasProposalChanges,
    listProposalChanges,
    type ProposalWorkspace,
    readProposalDiff,
    rejectProposal,
    removeProposalWorkspace,
} from '@/AIchat/utils/proposalWorkspace';
import type { FileContext } from '@/AIchat/types/aiTypes';
import * as bash from '@/utils/bashHelper';
import { openVim } from '@/utils/neovimHelper';
import { neovimConfig } from '@/filePaths';
import * as aiNeovimHelper from '@/AIchat/utils/conversationUtils/aiNeovimHelper';
import * as fileContext from '@/AIchat/utils/conversationUtils/fileContexts';
import { getFileOutline, formatOutline } from '@/AIchat/utils/fileOutline';

interface AgentConversationOptions {
    client: CopilotClient;
    role: string;
    model: string;
}

interface AgentUserInputResponse {
    answer: string;
    wasFreeform: boolean;
}

interface AgentConversationState {
    chatFile: string;
    model: string;
    role: string;
    client: CopilotClient;
    session: CopilotSession;
    nvim: neovim.NeovimClient;
    proposalWorkspace: ProposalWorkspace;
    isStreaming: boolean;
    approvalMode: 'strict' | 'yolo';
    allowedToolFamilies: Set<string>;
}

interface ToolApprovalResult {
    action: 'allow' | 'deny' | 'allow-family' | 'yolo';
    modifiedArgs?: unknown;
}

interface AgentPreToolUseHookInput {
    toolName: string;
    toolArgs: unknown;
}

interface ToolWritePreview {
    applyStrategy: 'content-field' | 'edit-tool';
    contentField?: 'content' | 'newContent';
    currentContent: string;
    diff: string;
    displayPath: string;
    note?: string;
    proposedContent: string;
    proposedEndsWithNewline: boolean;
}

interface AgentPreToolUseHookOutput {
    permissionDecision?: 'allow' | 'deny' | 'ask';
    permissionDecisionReason?: string;
    modifiedArgs?: unknown;
    additionalContext?: string;
    suppressOutput?: boolean;
}

function escapeForSingleQuotes(value: string): string {
    return value.replace(/'/g, `'\\''`);
}

function escapeForVimPath(value: string): string {
    return value.replace(/ /g, '\\ ');
}

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    if (typeof error === 'string') {
        return error;
    }

    return 'Unknown error.';
}

async function appendToChat(file: string, content: string): Promise<void> {
    await fs.appendFile(file, content, 'utf-8');
}

function quoteForShell(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function buildWritePreview(toolArgs: unknown, workspacePath: string): Promise<ToolWritePreview | undefined> {
    const request = extractWriteRequest(toolArgs, workspacePath);

    if (request) {
        const tempSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const currentPath = path.join(os.tmpdir(), `kra-agent-current-${tempSuffix}`);
        const proposedPath = path.join(os.tmpdir(), `kra-agent-proposed-${tempSuffix}`);

        let currentContent = '';
        try {
            currentContent = await fs.readFile(request.targetPath, 'utf8');
        } catch {
            currentContent = '';
        }

        await fs.writeFile(currentPath, currentContent, 'utf8');
        await fs.writeFile(proposedPath, request.nextContent, 'utf8');

        try {
            const result = await bash.execCommand(
                `git --no-pager diff --no-index -- ${quoteForShell(currentPath)} ${quoteForShell(proposedPath)} || true`
            );

            return {
                applyStrategy: 'content-field',
                contentField: request.contentField,
                currentContent,
                diff: result.stdout.trim(),
                displayPath: request.displayPath,
                proposedContent: request.nextContent,
                proposedEndsWithNewline: request.nextContent.endsWith('\n'),
            };
        } finally {
            await fs.rm(currentPath, { force: true });
            await fs.rm(proposedPath, { force: true });
        }
    }

    const editLinesRequest = extractEditLinesRequest(toolArgs, workspacePath);

    if (editLinesRequest) {
        let currentContent = '';
        try {
            currentContent = await fs.readFile(editLinesRequest.targetPath, 'utf8');
        } catch {
            currentContent = '';
        }

        const lines = currentContent.split('\n');
        const clampedEnd = Math.min(editLinesRequest.endLine, lines.length);
        const insertLines = editLinesRequest.newContent === '' ? [] : editLinesRequest.newContent.split('\n');
        const resultLines = [
            ...lines.slice(0, editLinesRequest.startLine - 1),
            ...insertLines,
            ...lines.slice(clampedEnd),
        ];
        const proposedContent = resultLines.join('\n');

        const tempSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const currentPath = path.join(os.tmpdir(), `kra-agent-current-${tempSuffix}`);
        const proposedPath = path.join(os.tmpdir(), `kra-agent-proposed-${tempSuffix}`);

        await fs.writeFile(currentPath, currentContent, 'utf8');
        await fs.writeFile(proposedPath, proposedContent, 'utf8');

        try {
            const result = await bash.execCommand(
                `git --no-pager diff --no-index -- ${quoteForShell(currentPath)} ${quoteForShell(proposedPath)} || true`
            );

            const note = editLinesRequest.newContent === ''
                ? `Deletes lines ${editLinesRequest.startLine}–${clampedEnd}. Edit the middle pane before approving.`
                : `Replaces lines ${editLinesRequest.startLine}–${clampedEnd} with ${insertLines.length} line${insertLines.length === 1 ? '' : 's'}. Approved edits are applied as a full-file replacement.`;

            return {
                applyStrategy: 'edit-tool',
                currentContent,
                diff: result.stdout.trim(),
                displayPath: editLinesRequest.displayPath,
                note,
                proposedContent,
                proposedEndsWithNewline: proposedContent.endsWith('\n'),
            };
        } finally {
            await fs.rm(currentPath, { force: true });
            await fs.rm(proposedPath, { force: true });
        }
    }

    const editRequest = extractEditRequest(toolArgs, workspacePath);

    if (!editRequest) {
        return undefined;
    }

    let currentContent = '';
    try {
        currentContent = await fs.readFile(editRequest.targetPath, 'utf8');
    } catch {
        currentContent = '';
    }

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

    const tempSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const currentPath = path.join(os.tmpdir(), `kra-agent-current-${tempSuffix}`);
    const proposedPath = path.join(os.tmpdir(), `kra-agent-proposed-${tempSuffix}`);

    await fs.writeFile(currentPath, currentContent, 'utf8');
    await fs.writeFile(proposedPath, proposedContent, 'utf8');

    try {
        const result = await bash.execCommand(
            `git --no-pager diff --no-index -- ${quoteForShell(currentPath)} ${quoteForShell(proposedPath)} || true`
        );

        return {
            applyStrategy: 'edit-tool',
            currentContent,
            diff: result.stdout.trim(),
            displayPath: editRequest.displayPath,
            note,
            proposedContent,
            proposedEndsWithNewline: proposedContent.endsWith('\n'),
        };
    } finally {
        await fs.rm(currentPath, { force: true });
        await fs.rm(proposedPath, { force: true });
    }
}

async function buildToolApprovalDetails(input: AgentPreToolUseHookInput, workspacePath: string): Promise<{
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
    const summary = typeof argsRecord?.command === 'string'
        ? `Command:\n${argsRecord.command}`
        : typeof argsRecord?.query === 'string'
            ? `Query:\n${argsRecord.query}`
            : typeof argsRecord?.path === 'string'
                ? `Path:\n${argsRecord.path}`
                : 'Arguments:';
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

async function promptToolApproval(
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

        const handler = (method: string, args: unknown[]) => {
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

async function applyStrReplaceEditorDirectly(
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

    // Truncate the file to empty, then return old_str='' so the SDK hits the fast path:
    //   !old_str && file.length===0  →  writes new_str as the complete file content.
    // This avoids fragile string-match logic entirely.
    await fs.writeFile(filePath, '', 'utf8');

    return {
        permissionDecision: 'allow',
        modifiedArgs: { ...args, old_str: '', new_str: finalContent },
    };
}

async function handleConfirmTaskComplete(
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

function extractFileReadPath(input: AgentPreToolUseHookInput, workspacePath: string): string | undefined {
    const args = getToolArgsRecord(input.toolArgs);
    if (!args) return undefined;

    const rawPath = typeof args.path === 'string' ? args.path : undefined;
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

async function handlePreToolUse(
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
                        `\nAvailable tools: get_outline(file_path), read_lines(file_path, start_line, end_line), read_function(file_path, function_name)`,
                    ].join('\n'),
                };
            }
        } catch {
            // File unreadable or not a text file — let the tool proceed normally.
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

    // For edit_lines: if the user edited the diff, convert the full-file result back
    // into line-range args that the MCP server can apply (start=1, end=huge → full replace).
    if (input.toolName.includes('edit_lines') && preview?.applyStrategy === 'edit-tool') {
        if (userNewStr !== undefined) {
            const args = getToolArgsRecord(input.toolArgs);
            return {
                permissionDecision: 'allow',
                modifiedArgs: { ...args, start_line: 1, end_line: 999999, new_content: userNewStr },
            };
        }
        return { permissionDecision: 'allow' };
    }

    if (decision.modifiedArgs) {
        return { permissionDecision: 'allow', modifiedArgs: decision.modifiedArgs };
    }

    return { permissionDecision: 'allow' };
}

function extractCurrentUserPrompt(lines: string[]): string {
    const draftPrompt = extractAgentDraftPrompt(lines);

    if (draftPrompt) {
        return draftPrompt;
    }

    let startIndex = -1;

    for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (isAgentUserHeader(lines[index])) {
            startIndex = index + 1;
            break;
        }
    }

    if (startIndex === -1) {
        return '';
    }

    return lines.slice(startIndex).join('\n').trim();
}

async function buildAttachments(): Promise<NonNullable<MessageOptions['attachments']>> {
    const attachments: NonNullable<MessageOptions['attachments']> = [];

    for (const context of fileContext.fileContexts) {
        const displayName = context.filePath.split('/').pop() || context.filePath;

        if (!context.isPartial) {
            attachments.push({
                type: 'file',
                path: context.filePath,
                displayName,
            });
            continue;
        }

        attachments.push(await createSelectionAttachment(context, displayName));
    }

    return attachments;
}

async function createSelectionAttachment(
    context: FileContext,
    displayName: string
): Promise<{
    type: 'selection',
    filePath: string,
    displayName: string,
    selection: {
        start: { line: number, character: number },
        end: { line: number, character: number },
    },
    text: string,
}> {
    const content = await fs.readFile(context.filePath, 'utf8');
    const allLines = content.split('\n');
    const startLine = context.startLine || 1;
    const endLine = context.endLine || startLine;
    const selectedText = allLines.slice(startLine - 1, endLine).join('\n');

    return {
        type: 'selection',
        filePath: context.filePath,
        displayName,
        selection: {
            start: { line: startLine - 1, character: 0 },
            end: { line: endLine - 1, character: allLines[endLine - 1]?.length || 0 },
        },
        text: selectedText,
    };
}

async function createAgentChatFile(chatFile: string): Promise<void> {
    const initialContent = `# Copilot Agent Chat

This session runs the Copilot SDK against a proposal workspace. Proposed edits are reviewed in Neovim before they are applied to the repository.

# Controls / Shortcuts:
#   Enter        -> Submit prompt
#   Ctrl+c       -> Stop current agent turn
#   @            -> Add file context
#   r            -> Remove file from context
#   f            -> Show active file contexts
#   Ctrl+x       -> Clear all contexts
#   <leader>t    -> Toggle popups for tools and agent current actions on/off
#
# Proposal controls (shown automatically after each turn with changes):
#   <leader>o    -> Open a changed proposal file
#   <leader>a    -> Apply proposal to the repository
#   <leader>r    -> Reject proposal
#
# Agent controls:
#   <leader>y    -> Toggle YOLO mode (auto-approve all tools)
#   <leader>P    -> Reset remembered tool approvals
#   <leader>h    -> Browse recent tool calls
#   <leader>?    -> Show all keymaps
${formatAgentDraftEntry().trimStart()}`;

    await fs.writeFile(chatFile, initialContent, 'utf8');
}

async function updateAgentUi(
    nvimClient: neovim.NeovimClient,
    method: string,
    args: unknown[] = []
): Promise<void> {
    try {
        await nvimClient.executeLua(`require('kra_agent_ui').${method}(...)`, args as VimValue[]);
    } catch {
        // Ignore UI update failures during startup/shutdown so the session itself can continue.
    }
}

async function handleAgentUserInput(
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

async function showProposalReview(nvimClient: neovim.NeovimClient, state: AgentConversationState): Promise<void> {
    const diff = await readProposalDiff(state.proposalWorkspace.workspacePath);

    if (!diff.trim()) {
        await nvimClient.command('echohl WarningMsg | echo "No proposal changes to review" | echohl None');
        return;
    }

    const lines = [
        '# Proposal review',
        '# a: apply  r: reject  o: open changed file  R: refresh  q: close',
        '',
        ...diff.split('\n'),
    ];

    await nvimClient.executeLua(`
        local content = ...
        local buf = vim.api.nvim_create_buf(false, true)
        vim.cmd('tabnew')
        vim.api.nvim_win_set_buf(0, buf)
        vim.api.nvim_buf_set_lines(buf, 0, -1, false, content)
        vim.api.nvim_buf_set_name(buf, 'kra-agent-review.diff')
        vim.bo[buf].buftype = 'nofile'
        vim.bo[buf].bufhidden = 'wipe'
        vim.bo[buf].swapfile = false
        vim.bo[buf].filetype = 'diff'
        vim.keymap.set('n', 'q', function() vim.cmd('close') end, { buffer = buf, silent = true })
        vim.keymap.set('n', 'a', function() vim.fn.rpcnotify(${await nvimClient.channelId}, 'prompt_action', 'apply_proposal') end, { buffer = buf, silent = true })
        vim.keymap.set('n', 'r', function() vim.fn.rpcnotify(${await nvimClient.channelId}, 'prompt_action', 'reject_proposal') end, { buffer = buf, silent = true })
        vim.keymap.set('n', 'o', function() vim.fn.rpcnotify(${await nvimClient.channelId}, 'prompt_action', 'open_proposal_file') end, { buffer = buf, silent = true })
        vim.keymap.set('n', 'R', function() vim.fn.rpcnotify(${await nvimClient.channelId}, 'prompt_action', 'review_proposal') end, { buffer = buf, silent = true })
    `, [lines]);
}

async function selectChangedProposalFile(
    nvimClient: neovim.NeovimClient,
    proposalFiles: string[]
): Promise<string | null> {
    const channelId = await nvimClient.channelId;

    return new Promise((resolve) => {
        const handler = (method: string, args: unknown[]) => {
            if (method !== 'proposal_file_selected') {
                return;
            }

            nvimClient.removeListener('notification', handler);
            resolve((args[0] as string) || null);
        };

        nvimClient.on('notification', handler);
        nvimClient.executeLua(`
            local files = ...
            local actions = require('telescope.actions')
            local action_state = require('telescope.actions.state')

            require('telescope.pickers').new({}, {
                prompt_title = 'Open proposal file',
                finder = require('telescope.finders').new_table(files),
                sorter = require('telescope.sorters').get_generic_fuzzy_sorter(),
                attach_mappings = function(prompt_bufnr, map)
                    actions.select_default:replace(function()
                        local selection = action_state.get_selected_entry()
                        actions.close(prompt_bufnr)
                        vim.fn.rpcnotify(${channelId}, 'proposal_file_selected', selection and (selection.value or selection[1]) or nil)
                    end)

                    map('i', '<Esc>', function()
                        actions.close(prompt_bufnr)
                        vim.fn.rpcnotify(${channelId}, 'proposal_file_selected', nil)
                    end)

                    return true
                end
            }):find()
        `, [proposalFiles]).catch(() => {
            nvimClient.removeListener('notification', handler);
            resolve(null);
        });
    });
}

async function openChangedProposalFile(state: AgentConversationState): Promise<void> {
    const changedFiles = await listProposalChanges(state.proposalWorkspace.workspacePath);

    if (!changedFiles.length) {
        await state.nvim.command('echohl WarningMsg | echo "No changed proposal files" | echohl None');
        return;
    }

    const selectedFile = await selectChangedProposalFile(state.nvim, changedFiles);

    if (!selectedFile) {
        await state.nvim.command('echohl WarningMsg | echo "No proposal file selected" | echohl None');
        return;
    }

    await state.nvim.command(`tabedit ${escapeForVimPath(`${state.proposalWorkspace.workspacePath}/${selectedFile}`)}`);
}

async function applyProposal(state: AgentConversationState): Promise<void> {
    const message = await applyProposalToRepo(
        state.proposalWorkspace.repoRoot,
        state.proposalWorkspace.workspacePath
    );

    await state.nvim.command(`echohl MoreMsg | echo '${escapeForSingleQuotes(message)}' | echohl None`);
}

async function rejectCurrentProposal(state: AgentConversationState): Promise<void> {
    await rejectProposal(state.proposalWorkspace.workspacePath);
    await state.nvim.command('echohl WarningMsg | echo "Rejected current proposal changes" | echohl None');
}

async function handleSubmit(state: AgentConversationState): Promise<void> {
    if (state.isStreaming) {
        await state.nvim.command('echohl WarningMsg | echo "Agent is still responding" | echohl None');
        return;
    }

    const buffer = await state.nvim.buffer;
    const lines = await buffer.lines;
    const prompt = extractCurrentUserPrompt(lines);

    if (!prompt) {
        await state.nvim.command('echohl WarningMsg | echo "Type a prompt before submitting" | echohl None');
        return;
    }

    if (lines.some((line) => isAgentDraftHeader(line))) {
        await fs.writeFile(state.chatFile, materializeAgentDraft(lines), 'utf8');
        await state.nvim.command('edit!');
    }

    state.isStreaming = true;
    await updateAgentUi(state.nvim, 'start_turn', [state.model]);
    await appendToChat(state.chatFile, formatAgentConversationEntry('ASSISTANT', { model: state.model }));
    await aiNeovimHelper.updateNvimAndGoToLastLine(state.nvim);

    const attachments = await buildAttachments();

    await state.session.send({
        prompt,
        attachments,
        mode: 'immediate',
    });
}

async function setupSessionEventHandlers(state: AgentConversationState): Promise<void> {
    const FLUSH_INTERVAL_MS = 100;

    let pendingBuffer = '';
    let activeToolCount = 0;
    let currentToolLabel = 'tool';
    let assistantStatusVisible = true;
    let firstToolThisTurn = true;
    let reasoningStarted = false;
    const toolLabels = new Map<string, string>();
    const toolStartLabels = new Map<string, string>();

    // Serialised write chain — all disk writes queue here so order is guaranteed
    // and concurrent writes cannot corrupt the file.
    let writeChain = Promise.resolve();

    const enqueue = (fn: () => Promise<void>): void => {
        writeChain = writeChain.then(fn).catch(() => {});
    };

    const nvimRefresh = (): Promise<void> =>
        state.nvim.command('edit!')
            .then(() => state.nvim.command('redraw!'))
            .catch(() => { /* neovim busy — skip */ });

    // Write text to the chat file and refresh neovim (through the queue).
    const write = (content: string, refresh = true): void => {
        enqueue(async () => {
            await appendToChat(state.chatFile, content);
            if (refresh) {
                await nvimRefresh();
            }
        });
    };

    // Drain the pending AI text buffer (called before each tool and at idle).
    const flushBuffer = (): void => {
        if (!pendingBuffer) {
            return;
        }

        const text = pendingBuffer;
        pendingBuffer = '';
        write(text);
    };

    // Flush AI text every FLUSH_INTERVAL_MS so streaming is visible.
    const flushTimer = setInterval(() => {
        if (pendingBuffer && activeToolCount === 0) {
            flushBuffer();
        }
    }, FLUSH_INTERVAL_MS);

    // ============================================================================
    // REASONING & CONTENT STREAMING
    // ============================================================================

    state.session.on('assistant.reasoning_delta', (event) => {
        enqueue(async () => {
            const prefix = !reasoningStarted ? '> 💭 ' : '';
            reasoningStarted = true;
            await appendToChat(state.chatFile, `${prefix}${event.data.deltaContent}`);
            await nvimRefresh();
        });
    });

    state.session.on('assistant.message_delta', (event) => {
        pendingBuffer += event.data.deltaContent;

        if (activeToolCount === 0 && !assistantStatusVisible) {
            assistantStatusVisible = true;
            void updateAgentUi(state.nvim, 'start_turn', [state.model]);
        }
    });

    // ============================================================================
    // TOOL EXECUTION HANDLERS
    // ============================================================================

    state.session.on('tool.execution_start', (event) => {
        activeToolCount += 1;
        const toolName = formatToolDisplayName(
            event.data.toolName,
            event.data.mcpServerName,
            event.data.mcpToolName
        );
        currentToolLabel = toolName;
        assistantStatusVisible = false;
        toolLabels.set(event.data.toolCallId, toolName);
        toolStartLabels.set(event.data.toolCallId, summarizeToolCall(toolName, event.data.arguments));

        // Flush any buffered AI text before the first tool of this group.
        if (firstToolThisTurn) {
            firstToolThisTurn = false;
            flushBuffer();
        }

        const details = `Running ${toolName}\n\nArguments:\n${formatToolArguments(event.data.arguments)}`;
        void updateAgentUi(state.nvim, 'start_tool', [toolName, details]);
    });

    state.session.on('tool.execution_progress', (event) => {
        currentToolLabel = toolLabels.get(event.data.toolCallId) || currentToolLabel;
        const details = `Running tool\n\n${formatToolProgress(event.data.progressMessage)}`;
        void updateAgentUi(state.nvim, 'update_tool', [currentToolLabel, details]);
    });

    state.session.on('tool.execution_partial_result', (event) => {
        currentToolLabel = toolLabels.get(event.data.toolCallId) || currentToolLabel;
        const details = `Streaming tool output\n\n${formatToolProgress(event.data.partialOutput)}`;
        void updateAgentUi(state.nvim, 'update_tool', [currentToolLabel, details]);
    });

    state.session.on('tool.execution_complete', (event) => {
        activeToolCount = Math.max(0, activeToolCount - 1);
        const toolName = toolLabels.get(event.data.toolCallId) || currentToolLabel;
        const toolSummary = toolStartLabels.get(event.data.toolCallId) || toolName;
        toolLabels.delete(event.data.toolCallId);
        toolStartLabels.delete(event.data.toolCallId);
        currentToolLabel = toolName;
        assistantStatusVisible = activeToolCount === 0;

        // After all tools finish, re-enable timer so next AI text is flushed.
        if (activeToolCount === 0) {
            firstToolThisTurn = true;
            reasoningStarted = false;
        }

        write(formatToolLine(toolSummary, event.data.success));

        const details = formatToolCompletion(event.data.success, event.data.result, event.data.error);
        void updateAgentUi(state.nvim, 'complete_tool', [
            toolName,
            details,
            event.data.success,
        ]);
    });

    // ============================================================================
    // SESSION STATE
    // ============================================================================

    state.session.on('session.idle', () => {
        void (async () => {
            clearInterval(flushTimer);
            flushBuffer();

            // Wait for all in-flight writes to finish before appending the draft.
            await writeChain;

            activeToolCount = 0;
            assistantStatusVisible = false;
            state.isStreaming = false;

            await appendToChat(state.chatFile, formatAgentDraftEntry());
            await nvimRefresh();
            await updateAgentUi(state.nvim, 'ready_for_next_prompt');
            await aiNeovimHelper.updateNvimAndGoToLastLine(state.nvim);

            if (await hasProposalChanges(state.proposalWorkspace.workspacePath)) {
                await showProposalReview(state.nvim, state);
            }
        })();
    });

    const QUOTA_WARN_THRESHOLDS = [50, 25, 10];
    const warnedThresholds = new Set<string>();
    const QUOTA_CACHE_PATH = path.join(os.homedir(), '.local', 'share', 'kra-tmux', 'quota-cache.json');

    state.session.on('assistant.usage', (event) => {
        const snapshots = event.data.quotaSnapshots;
        if (!snapshots) return;

        // Persist for `kra ai quota` to read
        const cache: Record<string, { remainingPercentage: number; resetDate: string | null; isUnlimitedEntitlement: boolean }> = {};
        for (const [id, snap] of Object.entries(snapshots)) {
            cache[id] = {
                remainingPercentage: snap.remainingPercentage,
                resetDate: snap.resetDate ?? null,
                isUnlimitedEntitlement: snap.isUnlimitedEntitlement,
            };
        }
        fs.mkdir(path.dirname(QUOTA_CACHE_PATH), { recursive: true })
            .then(() => fs.writeFile(QUOTA_CACHE_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), snapshots: cache }, null, 2)))
            .catch(() => { /* non-critical */ });

        for (const [quota_id, snap] of Object.entries(snapshots)) {
            if (snap.isUnlimitedEntitlement) continue;

            const pct = snap.remainingPercentage;
            const resetDate = snap.resetDate ? new Date(snap.resetDate).toLocaleString() : 'unknown';

            for (const threshold of QUOTA_WARN_THRESHOLDS) {
                const key = `${quota_id}:${threshold}`;
                if (pct <= threshold && !warnedThresholds.has(key)) {
                    warnedThresholds.add(key);
                    const label = quota_id === 'weekly' ? 'weekly usage limit' : `${quota_id} usage limit`;
                    const color = pct <= 10 ? '\x1b[31m' : '\x1b[33m';
                    console.warn(`\n${color}⚠ You've used over ${100 - threshold}% of your ${label}. Resets: ${resetDate}\x1b[0m\n`);
                }
            }
        }
    });
}

async function addAgentCommands(nvimClient: neovim.NeovimClient): Promise<void> {
    await nvimClient.command(`command! -nargs=0 ReviewProposal call ReviewProposal()`);
    await nvimClient.command(`command! -nargs=0 OpenProposalFile call OpenProposalFile()`);
    await nvimClient.command(`command! -nargs=0 ApplyProposal call ApplyProposal()`);
    await nvimClient.command(`command! -nargs=0 RejectProposal call RejectProposal()`);
    await nvimClient.command(`command! -nargs=0 AgentToolHistory lua require('kra_agent_ui').show_history()`);
    await nvimClient.command(`command! -nargs=0 AgentCommands lua require('which-key').show({ global = false })`);
}

async function addAgentFunctions(nvimClient: neovim.NeovimClient, channelId: number): Promise<void> {
    await nvimClient.command(`
        function! ReviewProposal()
            call rpcnotify(${channelId}, 'prompt_action', 'review_proposal')
        endfunction
    `);

    await nvimClient.command(`
        function! OpenProposalFile()
            call rpcnotify(${channelId}, 'prompt_action', 'open_proposal_file')
        endfunction
    `);

    await nvimClient.command(`
        function! ApplyProposal()
            call rpcnotify(${channelId}, 'prompt_action', 'apply_proposal')
        endfunction
    `);

    await nvimClient.command(`
        function! RejectProposal()
            call rpcnotify(${channelId}, 'prompt_action', 'reject_proposal')
        endfunction
    `);
}

async function setupAgentKeyBindings(nvimClient: neovim.NeovimClient): Promise<void> {
    await nvimClient.executeLua(`
        local map = vim.keymap.set
        local opts = { buffer = 0, silent = true }
        map('n', '<leader>d', '<Cmd>call ReviewProposal()<CR>', vim.tbl_extend('force', opts, { desc = 'Review proposal diff' }))
        map('n', '<leader>o', '<Cmd>call OpenProposalFile()<CR>', vim.tbl_extend('force', opts, { desc = 'Open proposal file' }))
        map('n', '<leader>a', '<Cmd>call ApplyProposal()<CR>', vim.tbl_extend('force', opts, { desc = 'Apply proposal changes' }))
        map('n', '<leader>r', '<Cmd>call RejectProposal()<CR>', vim.tbl_extend('force', opts, { desc = 'Reject proposal changes' }))
        map('n', '<leader>h', '<Cmd>AgentToolHistory<CR>', vim.tbl_extend('force', opts, { desc = 'Show tool history' }))
        map('n', '<leader>y', function() vim.fn.rpcnotify(${await nvimClient.channelId}, 'prompt_action', 'toggle_yolo_mode') end, vim.tbl_extend('force', opts, { desc = 'Toggle YOLO approvals' }))
        map('n', '<leader>P', function() vim.fn.rpcnotify(${await nvimClient.channelId}, 'prompt_action', 'reset_tool_approvals') end, vim.tbl_extend('force', opts, { desc = 'Reset remembered approvals' }))
        map('n', '<leader>?', '<Cmd>AgentCommands<CR>', vim.tbl_extend('force', opts, { desc = 'Show agent commands' }))
    `, []);
}

async function setupEventHandlers(state: AgentConversationState): Promise<void> {
    state.nvim.on('notification', async (method, args) => {
        if (method !== 'prompt_action') {
            return;
        }

        const action = args[0] as string;

        try {
            switch (action) {
                case 'submit_pressed':
                    await handleSubmit(state);
                    break;
                case 'add_file_context':
                    await fileContext.handleAddFileContext(state.nvim, state.chatFile, { agentMode: true });
                    break;
                case 'stop_stream':
                    await state.session.abort();
                    state.isStreaming = false;
                    await updateAgentUi(state.nvim, 'stop_turn', ['Stopped current agent turn']);
                    break;
                case 'show_contexts_popup':
                    await fileContext.showFileContextsPopup(state.nvim);
                    break;
                case 'remove_file_context':
                    await fileContext.handleRemoveFileContext(state.nvim);
                    break;
                case 'clear_contexts':
                    await fileContext.clearAllFileContexts(state.nvim);
                    break;
                case 'review_proposal':
                    await showProposalReview(state.nvim, state);
                    break;
                case 'open_proposal_file':
                    await openChangedProposalFile(state);
                    break;
                case 'apply_proposal':
                    await applyProposal(state);
                    break;
                case 'reject_proposal':
                    await rejectCurrentProposal(state);
                    break;
                case 'toggle_yolo_mode':
                    state.approvalMode = state.approvalMode === 'yolo' ? 'strict' : 'yolo';
                    state.allowedToolFamilies.clear();
                    await updateAgentUi(
                        state.nvim,
                        'show_error',
                        ['Approval mode', state.approvalMode === 'yolo' ? 'YOLO mode enabled.' : 'Strict approval mode enabled.']
                    );
                    break;
                case 'reset_tool_approvals':
                    state.approvalMode = 'strict';
                    state.allowedToolFamilies.clear();
                    await updateAgentUi(state.nvim, 'show_error', ['Approval mode', 'Reset remembered approvals.']);
                    break;
                default:
                    console.log('Unknown action:', action);
            }
        } catch (error) {
            await updateAgentUi(state.nvim, 'show_error', [
                `Action failed: ${action}`,
                getErrorMessage(error),
            ]);
        }
    });
}

async function openAgentNeovim(chatFile: string): Promise<neovim.NeovimClient> {
    const socketPath = await aiNeovimHelper.generateSocketPath();

    if (process.env.TMUX) {
        await bash.execCommand(buildAgentTmuxCommand(chatFile, socketPath));
    } else {
        void openVim(chatFile, '-u', neovimConfig, '--listen', socketPath);
    }

    await aiNeovimHelper.waitForSocket(socketPath);

    return neovim.attach({ socket: socketPath });
}

async function cleanup(state: AgentConversationState): Promise<void> {
    fileContext.clearFileContexts();
    await updateAgentUi(state.nvim, 'finish_turn');

    if (await hasProposalChanges(state.proposalWorkspace.workspacePath)) {
        console.log(`Unapplied proposal changes kept at ${state.proposalWorkspace.workspacePath}`);
    } else {
        await removeProposalWorkspace(
            state.proposalWorkspace.repoRoot,
            state.proposalWorkspace.workspacePath
        );
    }

    await fs.rm(state.chatFile, { force: true });
    await state.session.disconnect();
    await state.client.stop();
    process.exit(0);
}

export async function converseAgent(options: AgentConversationOptions): Promise<void> {
    fileContext.clearFileContexts();

    const proposalWorkspace = await createProposalWorkspace();
    const chatFile = `/tmp/kra-agent-chat-${Date.now()}.md`;
    await createAgentChatFile(chatFile);

    const nvimClient = await openAgentNeovim(chatFile);
    const userMcpServers = await getConfiguredMcpServers();
    const mcpServers = {
        ...userMcpServers,
        'kra-session-complete': {
            type: 'stdio' as const,
            command: process.execPath,
            args: [path.join(__dirname, '..', 'utils', 'sessionCompleteMcpServer.js')],
            tools: ['confirm_task_complete'],
        },
        'kra-file-context': {
            type: 'stdio' as const,
            command: process.execPath,
            args: [path.join(__dirname, '..', 'utils', 'fileContextMcpServer.js')],
            tools: ['get_outline', 'read_lines', 'read_function', 'edit_lines'],
        },
    };
    const stateRef: { current?: AgentConversationState } = {};
    const session = await options.client.createSession({
        clientName: 'copilot-cli',
        model: options.model,
        workingDirectory: proposalWorkspace.workspacePath,
        streaming: true,
        enableConfigDiscovery: true,
        mcpServers,
        onPermissionRequest: () => ({ kind: 'approved' }),
        infiniteSessions: {
            enabled: true,
            backgroundCompactionThreshold: 0.55,
            bufferExhaustionThreshold: 0.75,
        },
        hooks: {
            onPreToolUse: async (input) => {
                if (!stateRef.current) {
                    return {
                        permissionDecision: 'deny',
                        permissionDecisionReason: 'Agent UI is not ready yet.',
                    };
                }

                try {
                    return await handlePreToolUse(stateRef.current, input);
                } catch (error) {
                    await updateAgentUi(stateRef.current.nvim, 'show_error', [
                        `Pre-tool approval failed: ${input.toolName}`,
                        getErrorMessage(error),
                    ]);

                    return {
                        permissionDecision: 'deny',
                        permissionDecisionReason: `Pre-tool approval failed: ${getErrorMessage(error)}`,
                    };
                }
            },
            onPostToolUse: async (input) => {
                // Bash/shell output: errors and summaries land at the tail, so bias
                // toward keeping more of the end.  All other tools use a 50/50 split.
                const isBashLike = ['bash', 'shell', 'execute', 'run_terminal', 'computer'].some(
                    (fragment) => input.toolName.toLowerCase().includes(fragment)
                );
                const HEAD_CHARS = isBashLike ? 2000 : 4000;
                const TAIL_CHARS = isBashLike ? 6000 : 4000;
                const text = input.toolResult.textResultForLlm;
                if (text.length <= HEAD_CHARS + TAIL_CHARS) return;
                const omitted = text.length - HEAD_CHARS - TAIL_CHARS;
                return {
                    modifiedResult: {
                        ...input.toolResult,
                        textResultForLlm: [
                            text.slice(0, HEAD_CHARS),
                            `\n…[${omitted} chars omitted]…\n`,
                            text.slice(text.length - TAIL_CHARS),
                        ].join(''),
                    },
                };
            },
            onUserPromptSubmitted: async () => ({
                additionalContext: 'REMINDER: Call confirm_task_complete before ending your turn — whether you are done, need clarification, or want to ask the user anything.',
            }),
        },
        onUserInputRequest: async (request) => handleAgentUserInput(
            nvimClient,
            request.question,
            request.choices,
            request.allowFreeform ?? true
        ),
        systemMessage: {
            mode: 'append',
            content: `${aiRoles[options.role]}

            You are working inside a detached proposal workspace. Edit files there freely — the real repository is only updated after the user reviews and applies the resulting git diff from Neovim.

            TOOL USAGE — BE SURGICAL:
            - Editing: Always prefer kra-file-context:edit_lines(file_path, start_line, end_line, new_content) over the built-in edit/str_replace_editor. Line-range edits are precise and never fail due to stale old_str context. Workflow: get_outline → read_lines to confirm the target lines → edit_lines to replace them.
            - Creating new files: the built-in str_replace_editor with command=create is fine.

            CRITICAL RULE — ALWAYS call the confirm_task_complete tool before ending your turn.
            This applies in every situation:
            - When you think all tasks are done.
            - When you need clarification or more information from the user.
            - When you want to ask a follow-up question or present options.
            - When you are unsure what to do next.

            NEVER end your turn with plain text. ALWAYS call confirm_task_complete instead.
            Pass a concise summary and 2–4 concrete choices so the user can guide you.
            Their reply will be returned to you so you can continue without costing extra credits.`,
        },
    });

    const state: AgentConversationState = {
        chatFile,
        model: options.model,
        role: options.role,
        client: options.client,
        session,
        nvim: nvimClient,
        proposalWorkspace,
        isStreaming: false,
        approvalMode: 'strict',
        allowedToolFamilies: new Set<string>(),
    };
    stateRef.current = state;

    const channelId = await nvimClient.channelId;

    try {
        await aiNeovimHelper.addNeovimFunctions(nvimClient, channelId);
        await aiNeovimHelper.addCommands(nvimClient);
        await aiNeovimHelper.setupKeyBindings(nvimClient);
        await addAgentFunctions(nvimClient, channelId);
        await addAgentCommands(nvimClient);
        await setupAgentKeyBindings(nvimClient);
        await nvimClient.command(`edit ${chatFile}`);
        // Enable fold markers for the tool-call log blocks (uses default {{{/}}} markers).
        // foldlevel=99 keeps all folds open by default; user can fold with zc/za.
        await nvimClient.command('setlocal foldmethod=marker foldlevel=99');
        await aiNeovimHelper.updateNvimAndGoToLastLine(nvimClient);
        await setupSessionEventHandlers(state);
        await setupEventHandlers(state);

        nvimClient.on('disconnect', () => {
            void cleanup(state);
        });
    } catch (error) {
        await cleanup(state);
        throw error;
    }
}
