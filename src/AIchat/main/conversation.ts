import * as fs from 'fs/promises';
import * as neovim from 'neovim';
import { aiRoles } from '@/AIchat/data/roles';
import { promptModel } from '@/AIchat/utils/promptModel';
import { saveChat } from '@/AIchat/utils/saveChat';
import { formatChatEntry } from '@/AIchat/utils/aiUtils';
import { ChatHistory, Role, StreamController } from '@/AIchat/types/aiTypes'
import * as bash from '@/utils/bashHelper';
import { openVim } from '@/utils/neovimHelper';
import { neovimConfig } from '@/filePaths';
import * as aiNeovimHelper from '@/AIchat/utils/conversationUtils/aiNeovimHelper';
import * as fileContext from '@/AIchat/utils/conversationUtils/fileContexts'

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
            openVim(chatFile, `-u ${neovimConfig} --listen`, socketPath);
        }

        await aiNeovimHelper.waitForSocket(socketPath);

        const nvim = neovim.attach({ socket: socketPath });
        const channelId = await nvim.channelId;

        try {
            aiNeovimHelper.addNeovimFunctions(nvim, channelId);
            aiNeovimHelper.addCommands(nvim);
            aiNeovimHelper.setupKeyBindings(nvim);
        } catch (error) {
            console.error('Error setting up commands:', error);
        }

        // open the file in Neovim
        await nvim.command(`edit ${chatFile}`);
        await aiNeovimHelper.updateNvimAndGoToLastLine(nvim);
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
                await fileContext.handleRemoveFileContext(nvim);
                break;
            case 'clear_contexts':
                await fileContext.clearAllFileContexts(nvim);
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
    const buffer = await nvim.buffer;
    const lines = await buffer.lines;

    const conversationHistory = lines.join('\n');

    // Load fresh file contexts right before sending to LLM
    const fileContextPrompt = await fileContext.getFileContextsForPrompt();

    const fullPrompt = conversationHistory + fileContextPrompt + '\n';

    const aiEntryHeader = formatChatEntry('AI - ' + model, '', false);
    await appendToChat(chatFile, aiEntryHeader);
    await aiNeovimHelper.updateNvimAndGoToLastLine(nvim);

    // create stream controller for this request
    currentStreamController = createStreamController();

    try {
        const response = await promptModel(
            provider,
            model,
            fullPrompt,
            temperature,
            aiRoles[role],
            currentStreamController
        );

        await handleStreamingResponse(response, chatFile, nvim, currentStreamController);
    } catch (error: unknown) {
        if (currentStreamController?.isAborted) {
            await appendToChat(chatFile, '\n[Generation stopped by user]\n');
            await aiNeovimHelper.updateNvimAndGoToLastLine(nvim);
        } else {
            console.error('Error in AI response:', error);
            await appendToChat(chatFile, '\n[Error generating response]\n');
            await aiNeovimHelper.updateNvimAndGoToLastLine(nvim);
        }
    } finally {
        currentStreamController = null;
        await appendToChat(chatFile, '\n');
        const userEntryHeader = formatChatEntry('USER', '', false);
        await appendToChat(chatFile, userEntryHeader);
        await aiNeovimHelper.updateNvimAndGoToLastLine(nvim);
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

    try {
        for await (const chunk of response) {
            if (controller.isAborted) {
                break;
            }

            pendingBuffer += chunk;

            if (Date.now() - lastUpdate >= updateInterval) {
                await appendToChat(chatFile, pendingBuffer);
                await nvim.command('edit!');
                await nvim.command('redraw!');
                pendingBuffer = '';
                lastUpdate = Date.now();
            }
        }

        // write any remaining buffer
        if (pendingBuffer && !controller.isAborted) {
            await appendToChat(chatFile, pendingBuffer);
            await nvim.command('edit!');
            await nvim.command('redraw!');
        }

        await appendToChat(chatFile, '\n');
        await aiNeovimHelper.updateNvimAndGoToLastLine(nvim);
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

export async function initializeChatFile(filePath: string, userPrompt: boolean = false): Promise<void> {
    let initialContent = `
# AI Chat History\n\nThis file contains the conversation history between the user and AI.\n
        # ✨ Controls / Shortcuts:
        #   ⏎  Enter     → Save & Submit
        #   📎  @        → Add File Context
        #   ❌  r        → Remove File From Context
        #   📂  f        → Show Files Currently Context
        #   🗑️  <C-x>    → Clear Contexts
        #   ⏹️  <C-c>    → Stop Stream

# 💡 Tip: Press the keys in normal mode to trigger actions
`;

    if (userPrompt) {
        initialContent += `---\n\n### USER (${new Date().toISOString()})\n\n`
    }

    await fs.writeFile(filePath, initialContent, 'utf-8');
}

async function appendToChat(file: string, content: string): Promise<void> {
    await fs.appendFile(file, content, 'utf-8');
}

function parseChatHistory(historyString: string): ChatHistory[] {
    const chatMessages: ChatHistory[] = [];
    const lines = historyString.split(/\n/);

    let currentRole: Role | null = null;
    let currentTextLines: string[] = [];
    let currentTimestamp: string = '';

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
        const isUserMarker = line.startsWith("### USER (");
        const isAiMarker = line.startsWith("### AI -");

        if (isUserMarker || isAiMarker) {
            flushMessage();
            currentTimestamp = extractTimestamp(line) || '';
            currentRole = isUserMarker ? Role.User : Role.AI;
            currentTextLines = [];
        } else if (currentRole !== null) {
            currentTextLines.push(line);
        }
    }

    flushMessage();
    return chatMessages;
}

function extractTimestamp(line: string): string | null {
    const match = line.match(/\(([^)]+)\)/);
    return match ? match[1] : null;
}
