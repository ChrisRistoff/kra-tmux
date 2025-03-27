import * as fs from 'fs/promises';
import { aiRoles } from '@AIchat/data/roles';
import { promptModel } from './promptModel';
import { saveChat } from './saveChat';
import * as neovim from 'neovim';
import * as bash from '@utils/bashHelper';
import os from 'os';
import { formatChatEntry } from './aiUtils';
import { openVim } from '@/utils/neovimHelper';
import { ChatHistory, Role } from '@AIchat/types/aiTypes'

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
            await initializeChatFile(chatFile, true);
        }

        const socketPath = await generateSocketPath();

        if (process.env.TMUX) {
            const tmuxCommand = `tmux split-window -v -p 90 -c "#{pane_current_path}" \; \
                tmux send-keys -t :. 'sh -c "trap \\"exit 0\\" TERM; nvim --listen \\"${socketPath}\\" \\"${chatFile}\\"d;
                tmux send-keys exit C-m"' C-m`

            bash.execCommand(tmuxCommand);
        } else {
            openVim(chatFile, '--listen', socketPath);
        }

        await waitForSocket(socketPath);

        const nvim = neovim.attach({ socket: socketPath });
        const channelId = await nvim.channelId;

        // create commands for saving and submitting
        await nvim.command(`
            function! SaveAndSubmit()
                normal! o
                write
                call rpcnotify(${channelId}, 'prompt_action', 'submit_pressed')
            endfunction
            command! SubmitPrompt call SaveAndSubmit()
        `);

        await nvim.command(`nnoremap <CR> :SubmitPrompt<CR>`);

        // open the file in Neovim
        await nvim.command(`edit ${chatFile}`);
        await updateNvimAndGoToLastLine(nvim);

        await onHitEnterInNeovim(nvim, chatFile, provider,  model, temperature, role);

        nvim.on('disconnect', async () => {
            console.log('Chat Ended.');

            const conversationHistory = await fs.readFile(chatFile, 'utf8');
            const fullPrompt = conversationHistory + '\n';

            await saveChat(chatFile, temperature, role, provider, model, parseChatHistory(fullPrompt));

            await fs.rm(chatFile);
        })
    } catch (error) {
        console.error('Error in AI prompt workflow:', (error as Error).message);

        throw error;
    }
}

export async function initializeChatFile(filePath: string, userPrompt: boolean = false): Promise<void> {
    let initialContent = `# AI Chat History\n\nThis file contains the conversation history between the user and AI.\n\n`;

    if (userPrompt) {
        initialContent += `---\n\n### USER (${new Date().toISOString()})\n\n`
    }

    await fs.writeFile(filePath, initialContent, 'utf-8');
}

async function waitForSocket(socketPath: string, timeout = 5000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        try {
            await fs.access(socketPath);

            return true;
        } catch (err) {
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }

    return false;
}

async function generateSocketPath(): Promise<string> {
    const randomString = Math.random().toString(36).substring(2, 15);

    return `${os.tmpdir()}/nvim-${randomString}.sock`;
}

async function appendToChat(file: string, content: string): Promise<void> {
    await fs.appendFile(file, content, 'utf-8');
}

async function updateNvimAndGoToLastLine(nvim: neovim.NeovimClient): Promise<void> {
    await nvim.command('edit!');
    await nvim.command('normal! G');
    await nvim.command('normal! o');
}

async function onHitEnterInNeovim(nvim: neovim.NeovimClient, chatFile: string,provider: string, model: string, temperature: number, role: string): Promise<void> {
    nvim.on('notification', async (method, args) => {
        if (method === 'prompt_action' && args[0] === 'submit_pressed') {
            const buffer = await nvim.buffer;
            const lines = await buffer.lines;

            const conversationHistory = lines.join('\n');
            const fullPrompt = conversationHistory + '\n';

            const aiEntryHeader = formatChatEntry('AI - ' + model, '', false);
            await appendToChat(chatFile, aiEntryHeader);
            await updateNvimAndGoToLastLine(nvim);

            const response = await promptModel(provider, model, fullPrompt, temperature, aiRoles[role]);

            if (typeof response === 'string') {
                await appendToChat(chatFile, response);
                await appendToChat(chatFile, '\n');

                await updateNvimAndGoToLastLine(nvim);
            } else {
                try {
                    let fullResponse = '';
                    let pendingBuffer = '';
                    let lastUpdate = Date.now();

                    const updateInterval = 0;

                    for await (const chunk of response) {
                        fullResponse += chunk;
                        pendingBuffer += chunk;

                        if (Date.now() - lastUpdate >= updateInterval) {
                            await appendToChat(chatFile, pendingBuffer);
                            await nvim.command('edit!');
                            await nvim.command('redraw!');
                            pendingBuffer = '';
                            lastUpdate = Date.now();
                        }
                    }

                    if (pendingBuffer) {
                        await appendToChat(chatFile, pendingBuffer);
                        await nvim.command('edit!');
                        await nvim.command('redraw!');
                    }

                    await appendToChat(chatFile, '\n');
                    await updateNvimAndGoToLastLine(nvim);
                } catch (error) {
                    console.log(error);
                }
            }

            await appendToChat(chatFile, '\n');
            const userEntryHeader = formatChatEntry('USER', '', false);
            await appendToChat(chatFile, userEntryHeader);
            await updateNvimAndGoToLastLine(nvim);
        }
    });
}

function parseChatHistory(historyString: string): ChatHistory[] {
    const chatMessages: ChatHistory[] = [];
    const lines = historyString.split(/\n/);

    let currentRole: Role | null = null;
    let currentTextLines: string[] = [];
    let currentTimestamp: string | null = null;

    for (const line of lines) {
        // avoid occurrences of "###" or role names within message
        const isUserMarker = line.startsWith("### USER (");
        const isAiMarker = line.startsWith("### AI -");

        if (isUserMarker || isAiMarker) {
            if (currentRole !== null && currentTimestamp !== null && currentTextLines.length > 0) {
                const messageText = currentTextLines.join("\n").trim();

                if (messageText) {
                    chatMessages.push({
                        role: currentRole,
                        message: messageText,
                        timestamp: currentTimestamp,
                    });
                }
            }

            currentTimestamp = extractTimestamp(line);
            currentRole = isUserMarker ? Role.User : Role.AI;
            currentTextLines = [];
        } else if (currentRole !== null) {
            currentTextLines.push(line);
        }
    }

    if (currentRole !== null && currentTimestamp !== null && currentTextLines.length > 0) {
        const messageText = currentTextLines.join("\n").trim();

        if (messageText) {
            chatMessages.push({
                role: currentRole,
                message: messageText,
                timestamp: currentTimestamp,
            });
        }
    }

    return chatMessages;
}

function extractTimestamp(line: string): string | null {
    const match = line.match(/\(([^)]+)\)/);
    return match ? match[1] : null;
}
