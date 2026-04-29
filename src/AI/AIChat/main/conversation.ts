import * as fs from 'fs/promises';
import * as neovim from 'neovim';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { aiRoles } from '@/AI/shared/data/roles';
import { promptModel } from '@/AI/AIChat/utils/promptModel';
import { saveChat } from '@/AI/AIChat/utils/saveChat';
import { ChatHistory, Role, StreamController } from '@/AI/shared/types/aiTypes'
import * as bash from '@/utils/bashHelper';
import { openVim } from '@/utils/neovimHelper';
import { neovimConfig } from '@/filePaths';
import * as conversation from '@/AI/shared/conversation';
import {
    extractTimestampFromHeader,
    formatAssistantHeader,
    formatUserDraftHeader,
    isAssistantHeader,
    isUserHeader,
    materializeUserDraft,
} from '@/AI/shared/utils/conversationUtils/chatHeaders';
const aiNeovimHelper = conversation;
const fileContext = conversation;

// stream controller for the current request
let currentStreamController: StreamController | null = null;

export async function converse(
    chatFile: string,
    temperature: number,
    role: string,
    provider: string,
    model: string,
    isChatLoaded = false,
): Promise<void> {
    try {
        if (!isChatLoaded) {
            fileContext.clearFileContexts();
            await initializeChatFile(chatFile, true);
        } else {
            await fileContext.rebuildFileContextsFromChat(chatFile);
        }

        const socketPath = await aiNeovimHelper.generateSocketPath();

        // open neovim and listen to socket
        if (process.env.TMUX) {
            const tmuxCommand = `tmux split-window -v -p 90 -c "#{pane_current_path}" \; \
                tmux send-keys -t :. 'sh -c "trap \\"exit 0\\" TERM; nvim -u ${neovimConfig} --listen \\"${socketPath}\\" \\"${chatFile}\\"d;
                tmux send-keys exit C-m"' C-m`

            bash.execCommand(tmuxCommand);
        } else {
            openVim(chatFile, '-u', neovimConfig, '--listen', socketPath);
        }

        await aiNeovimHelper.waitForSocket(socketPath);

        const nvim = neovim.attach({ socket: socketPath });
        const channelId = await nvim.channelId;

        try {
            await aiNeovimHelper.addNeovimFunctions(nvim, channelId);
            await aiNeovimHelper.addCommands(nvim);
            await aiNeovimHelper.setupKeyBindings(nvim);
        } catch (error) {
            console.error('Error setting up commands:', error);
        }

        // open the file in Neovim
        await nvim.command(`edit ${chatFile}`);
        await aiNeovimHelper.setupChatSplitLayout(nvim, channelId);
        await aiNeovimHelper.refreshChatLayout(nvim);
        await aiNeovimHelper.focusChatPrompt(nvim);
        await setupEventHandlers(nvim, chatFile, provider, model, temperature, role);

        nvim.on('disconnect', async () => {
            console.log('Chat Ended.');

            const conversationHistory = await fs.readFile(chatFile, 'utf8');
            const fullPrompt = conversationHistory + '\n';

            await saveChat(chatFile, provider, model, role, temperature, parseChatHistory(fullPrompt));

            await fs.rm(chatFile);
        })
    } catch (error) {
        console.error('Error in AI prompt workflow:', (error as Error).message);
        throw error;
    }
}

async function setupEventHandlers(
    nvim: neovim.NeovimClient,
    chatFile: string,
    provider: string,
    model: string,
    temperature: number,
    role: string
): Promise<void> {
    nvim.on('notification', async (method, args) => {
        if (method !== 'prompt_action') return;

        const action = args[0] as string;

        switch (action) {
            case 'submit_pressed':
                await handleSubmit(nvim, chatFile, provider, model, temperature, role);
                break;
            case 'add_file_context':
                await fileContext.handleAddFileContext(nvim, chatFile);
                break;
            case 'stop_stream':
                await aiNeovimHelper.handleStopStream(currentStreamController, nvim);
                break;
            case 'show_contexts_popup':
                await fileContext.showFileContextsPopup(nvim);
                break;
            case 'remove_file_context':
                await fileContext.handleRemoveFileContext(nvim, chatFile);
                break;
            case 'clear_contexts':
                await fileContext.clearAllFileContexts(nvim, chatFile);
                break;
            default:
                console.log('Unknown action:', action);
        }
    });
}

async function handleSubmit(
    nvim: neovim.NeovimClient,
    chatFile: string,
    provider: string,
    model: string,
    temperature: number,
    role: string
): Promise<void> {
    const prompt = await aiNeovimHelper.getChatPromptText(nvim);

    if (!prompt.trim()) {
        await nvim.command('echohl WarningMsg | echo "Type a prompt before submitting" | echohl None');
        await aiNeovimHelper.focusChatPrompt(nvim);

        return;
    }

    const conversationHistory = await fs.readFile(chatFile, 'utf8');
    const trimmedPrompt = prompt.trim();
    const turnTimestamp = new Date().toISOString();
    const promptCompletion = `${trimmedPrompt}\n`;

    // Replace the trailing `(draft)` USER header with a real timestamped one
    // so the prompt body (and any @-added file context) sits under it cleanly.
    await materializeUserDraft(chatFile, turnTimestamp);
    await appendToChat(chatFile, promptCompletion);
    await aiNeovimHelper.clearChatPrompt(nvim);

    // Load fresh file contexts right before sending to LLM.
    const fileContextPrompt = await fileContext.getFileContextsForPrompt();
    const priorMessages = chatHistoryToMessages(parseChatHistory(conversationHistory));
    const newUserMessage = trimmedPrompt + (fileContextPrompt ? `\n\n${fileContextPrompt}` : '');
    const messages: ChatCompletionMessageParam[] = [
        ...priorMessages,
        { role: 'user', content: newUserMessage },
    ];

    await appendToChat(chatFile, formatAssistantHeader(model, turnTimestamp));
    await aiNeovimHelper.refreshChatLayout(nvim);
    await aiNeovimHelper.focusChatPrompt(nvim);

    // create stream controller for this request
    currentStreamController = createStreamController();

    try {
        const response = await promptModel(
            provider,
            model,
            messages,
            temperature,
            aiRoles[role],
            currentStreamController,
            { nvim, chatFile },
        );

        await handleStreamingResponse(response, chatFile, nvim, currentStreamController);
    } catch (error: unknown) {
        if (currentStreamController.isAborted) {
            await appendToChat(chatFile, '\n[Generation stopped by user]\n');
        } else {
            console.error('Error in AI response:', error);
            await appendToChat(chatFile, '\n[Error generating response]\n');
        }
    } finally {
        currentStreamController = null;
        await appendToChat(chatFile, formatUserDraftHeader());
        await aiNeovimHelper.refreshChatLayout(nvim);
        await aiNeovimHelper.focusChatPrompt(nvim);
    }
}

async function handleStreamingResponse(
    response: AsyncIterable<string>,
    chatFile: string,
    nvim: neovim.NeovimClient,
    controller: StreamController
): Promise<void> {
    let pendingBuffer = '';
    let lastUpdate = Date.now();
    const updateInterval = 100;
    let trailingNewlines = 0;

    const normalize = (chunk: string): string => {
        let out = '';
        for (const ch of chunk) {
            if (ch === '\n') {
                if (trailingNewlines < 2) {
                    out += ch;
                }
                trailingNewlines++;
            } else {
                trailingNewlines = 0;
                out += ch;
            }
        }
        return out;
    };

    try {
        for await (const chunk of response) {
            if (controller.isAborted) {
                break;
            }

            pendingBuffer += normalize(chunk);

            if (Date.now() - lastUpdate >= updateInterval) {
                if (pendingBuffer) {
                    await appendToChat(chatFile, pendingBuffer);
                    await aiNeovimHelper.refreshChatLayout(nvim);
                    pendingBuffer = '';
                }
                lastUpdate = Date.now();
            }
        }

        if (pendingBuffer && !controller.isAborted) {
            await appendToChat(chatFile, pendingBuffer);
            await aiNeovimHelper.refreshChatLayout(nvim);
        }

        await aiNeovimHelper.refreshChatLayout(nvim);
    } catch (error: unknown) {
        if (!controller.isAborted) {
            throw error;
        }
    }
}


function createStreamController(): StreamController {
    let isAborted = false;

    return {
        abort: () => {
            isAborted = true;
        },
        get isAborted() {
            return isAborted;
        }
    };
}

export async function initializeChatFile(filePath: string, userPrompt = false): Promise<void> {
    const initialContent = `
# AI Chat History

This file contains the conversation history between the user and AI.

        # Controls / Shortcuts:
        #   Enter          -> Submit prompt
        #   Tab / S-Tab    -> Switch between transcript and prompt
        #   @              -> Add File Context(s) (<Tab> multi-select, + marks selections, <CR> confirm, <Esc> cancel)
        #   r              -> Remove File From Context
        #   f              -> Show Current File Contexts
        #   <C-x>          -> Clear Contexts
        #   <C-c>          -> Stop Stream
        #   <leader>h      -> Show tool call history (web_fetch / web_search)
        #
        # Tip: Type your next message in the bottom prompt split.
`;

    const finalContent = userPrompt
        ? `${initialContent}${formatUserDraftHeader()}`
        : initialContent;

    await fs.writeFile(filePath, finalContent, 'utf-8');
}

async function appendToChat(file: string, content: string): Promise<void> {
    await fs.appendFile(file, content, 'utf-8');
}

function parseChatHistory(historyString: string): ChatHistory[] {
    const chatMessages: ChatHistory[] = [];
    const lines = historyString.split(/\n/);

    let currentRole: Role | null = null;
    let currentTextLines: string[] = [];
    let currentTimestamp = '';

    const flushMessage = () => {
        if (currentRole !== null && currentTextLines.length > 0) {
            const messageText = currentTextLines.join("\n").trim();
            if (messageText) {
                chatMessages.push({
                    role: currentRole,
                    message: messageText,
                    timestamp: currentTimestamp,
                });
            }
        }
    };

    for (const line of lines) {
        const isUserMarker = isUserHeader(line) || line.startsWith('### USER (');
        const isAiMarker = isAssistantHeader(line) || line.startsWith('### AI -');

        if (isUserMarker || isAiMarker) {
            flushMessage();
            currentTimestamp = (isUserHeader(line) || isAssistantHeader(line))
                ? extractTimestampFromHeader(line)
                : (extractTimestamp(line) ?? '');
            currentRole = isUserMarker ? Role.User : Role.AI;
            currentTextLines = [];
        } else if (currentRole !== null) {
            currentTextLines.push(line);
        }
    }

    flushMessage();

    return chatMessages;
}

const TOOL_MARKER_LINE = /^\s*`[✓✗]\s[^`]*`\s*$/;

function stripToolMarkers(message: string): string {
    return message
        .split('\n')
        .filter((line) => !TOOL_MARKER_LINE.test(line))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function chatHistoryToMessages(history: ChatHistory[]): ChatCompletionMessageParam[] {
    return history
        .map<ChatCompletionMessageParam>((entry) => ({
            role: entry.role === Role.User ? 'user' : 'assistant',
            content: entry.role === Role.User ? entry.message : stripToolMarkers(entry.message),
        }))
        .filter((m) => typeof m.content === 'string' && m.content.length > 0);
}

function extractTimestamp(line: string): string | null {
    const match = line.match(/\(([^)]+)\)/);

    return match ? match[1] : null;
}
