import inquirer from 'inquirer';
import * as fs from 'fs/promises';
import { aiRoles } from '@AIchat/data/roles';
import { promptModel } from './promptModel';
import { saveChat } from './saveChat';
import * as neovim from 'neovim';
import * as bash from '@utils/bashHelper';

export async function promptUserForTemperature() {
    const optionsArray: string[] = [];

    for (let i = 0; i <= 10; i++) {
        optionsArray.push(i.toString());
    }

    const { selectedOption } = await inquirer.prompt([
        {
            type: 'autocomplete',
            name: 'selectedOption',
            message: 'Choose temperatur 1-10(0.1 - 1.0)',
            source: (_answersSoFar: string[], input: string) => {
                if (!input) {
                  return optionsArray
                }

                return optionsArray.filter(option =>
                    option.includes(input)
                );
            },
        },
    ]);

    return +selectedOption / 10;
}

export async function converse(
    chatFile: string,
    temperature: number,
    role: string,
    model: string,
    isChatLoaded = false,
): Promise<void> {
    try {
        if (!isChatLoaded) {
            await initializeUserPrompt(chatFile);
        }

        const socketPath = '/tmp/nvim.sock';

        const tmuxCommand = `tmux new-window "nvim --listen /tmp/nvim.sock ${chatFile}"`;
        await bash.execCommand(tmuxCommand);

        await waitForSocket(socketPath);

        const nvim = neovim.attach({ socket: '/tmp/nvim.sock' });
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

        // Open the file in Neovim
        await nvim.command(`edit ${chatFile}`);
        await nvim.command('normal! G');
        await nvim.command('normal! o');

        // ON ENTER
        nvim.on('notification', async (method, args) => {
            if (method === 'prompt_action' && args[0] === 'submit_pressed') {
                const buffer = await nvim.buffer;
                const lines = await buffer.lines;

                // Get the full conversation history
                const conversationHistory = lines.join('\n');
                const fullPrompt = conversationHistory + '\n';

                // Get AI response
                const response = await promptModel(model, fullPrompt, temperature, aiRoles[role]);

                // Format and append the AI response
                const aiEntry = formatChatEntry(model, response);
                await appendToChat(chatFile, aiEntry);

                // Add new user prompt section
                await appendToChat(chatFile, formatUserPromptArea());

                // Refresh the buffer and move cursor to the end
                await nvim.command('edit!');
                await nvim.command('normal! G');
                await nvim.command('normal! o'); // Move cursor down one line

            }
        });

        let intervalId: NodeJS.Timeout | undefined;
        intervalId = setInterval(async () => {
            try {
                await fs.access(socketPath); // socket exists
            } catch (error) { // socket does not exist
                console.log('Chat Ended.');
                clearInterval(intervalId);

                const conversationHistory = await fs.readFile(chatFile, 'utf8');
                const fullPrompt = conversationHistory + '\n';

                await saveChat(chatFile, fullPrompt, temperature, role, model);
            }
        }, 500);
    } catch (error) {
        console.error('Error in AI prompt workflow:', (error as Error).message);
        throw error;
    }
}

async function waitForSocket(socketPath: string, timeout = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        try {
            await fs.access(socketPath); // Check if socket file exists
            return true;
        } catch (err) {
            await new Promise(resolve => setTimeout(resolve, 100)); // retry every 100ms
        }
    }
    return false;
}

function formatUserPromptArea(): string {
    return `### USER (${new Date().toISOString()})\n`;
}

async function initializeUserPrompt(filePath: string): Promise<void> {
    const initialContent = `# AI Chat History\n\nThis file contains the conversation history between the user and AI.\n\n---\n\n### USER (${new Date().toISOString()})\n\n`;
    await fs.writeFile(filePath, initialContent, 'utf-8');
}

export async function clearPromptFile(promptFile: string): Promise<void> {
    await fs.writeFile(promptFile, '', 'utf-8');
}

export function formatChatEntry(role: string, content: string, topLevel = false): string {
    const timestamp = new Date().toISOString();
    if (topLevel) {
        return `### ${role} (${timestamp})\n\n${content}\n---\n`;
    }

    return `---\n### ${role} (${timestamp})\n\n${content}\n---\n`;
}

async function appendToChat(file: string, content: string): Promise<void> {
    await fs.appendFile(file, content, 'utf-8');
}
