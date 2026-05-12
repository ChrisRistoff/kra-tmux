import * as fs from 'fs/promises';
import * as path from 'path';
import * as conversation from '@/AI/AIChat/main/conversation';
import { ChatData, Role, SavedFileContext } from '@/AI/shared/types/aiTypes'
import { getModelCatalog } from '@/AI/shared/data/modelCatalog';
import { SUPPORTED_PROVIDERS, type SupportedProvider } from '@/AI/shared/data/providers';
import { formatChatEntry, pickProviderAndModel } from '@/AI/AIChat/utils/aiUtils';
import {
    formatAssistantHeader,
    formatUserDraftHeader,
    formatUserHeader,
} from '@/AI/shared/utils/conversationUtils/chatHeaders';
import * as ui from '@/UI/generalUI';
import { filterGitKeep } from '@/utils/common';
import { aiHistoryPath } from '@/filePaths';
import { getFileExtension } from '@/AI/shared/conversation';

export async function loadChat(): Promise<void> {
    try {
        const savedChats = await fs.readdir(aiHistoryPath);

        if (savedChats.length === 0) {
            console.log('No saved chats found.');

            return;
        }
        const selectedChat = await ui.searchSelectAndReturnFromArray({
            itemsArray: filterGitKeep(savedChats),
            prompt: 'Select a chat to load',
            header: `${filterGitKeep(savedChats).length} saved chat(s)`,
            details: async (name) => {
                try {
                    const dataPath = path.join(aiHistoryPath, name, `${name}.json`);
                    const data: ChatData = JSON.parse(await fs.readFile(dataPath, 'utf-8'));
                    const turns = data.chatHistory.length ?? 0;
                    const lines: string[] = [
                        `chat: ${name}`,
                        `provider: ${data.provider ?? '?'}`,
                        `model: ${data.model ?? '?'}`,
                        `role: ${data.role ?? '?'}`,
                        `temperature: ${data.temperature ?? '?'}`,
                        `turns: ${turns}`,
                        '',
                        '--- summary ---',
                        (data.summary ?? '(no summary)').slice(0, 4000),
                    ];

                    return lines.join('\n');
                } catch (e: unknown) {
                    return `Failed to read chat: ${e instanceof Error ? e.message : String(e)}`;
                }
            },
        });

        // Hand chatTui the saved JSON directly. No more transient
        // /tmp/ai-chat-*.md scratch file — chatTui reads the JSON once at
        // startup, hydrates `sessionTurns`/`sessionMessages`, and runs
        // purely in memory afterwards. The saved JSON is the canonical
        // persisted artifact and must never be deleted.
        const chatDataPath = path.join(aiHistoryPath, selectedChat, `${selectedChat}.json`);
        const chatData: ChatData = JSON.parse(await fs.readFile(chatDataPath, 'utf-8'));
        const chatSummaryPath = path.join(aiHistoryPath, selectedChat, 'summary.md');

        await fs.writeFile(chatSummaryPath, formatChatEntry('Chat Summary', `${chatData.summary ?? ''}\n`, true));

        // No transcript materialization to disk — chatTui reads the
        // saved JSON itself and renders the transcript straight into
        // the in-memory blessed widget.
        void formatFullChat;
        void formatUserDraftHeader;

        if (!chatData.provider || !(await checkProviderAndModelValid(chatData.provider, chatData.model))) {
            console.log('Pick a new provider');
            console.log('Old model on save: ', chatData.model);

            const { provider, model } = await pickProviderAndModel();

            chatData.provider = provider;
            chatData.model = model;
        }

        // File-context restoration happens inside chatTui from the
        // same saved JSON; no need to write blobs into a scratch file.
        void restoreFileContexts;

        const chatFileLoaded = true;
        await conversation.converse(
            chatDataPath,
            chatData.temperature,
            chatData.role,
            chatData.provider,
            chatData.model,
            chatFileLoaded
        );
    } catch (error) {
        console.error('Error loading chat:', (error as Error).message);
        throw error;
    }
}

function formatFullChat(chatData: ChatData): string {
    return chatData.chatHistory.map((entry: any) => {
        if (entry.role === Role.AI) {
            return `${formatAssistantHeader(chatData.model, entry.timestamp)}${entry.message}`;
        }

        return `${formatUserHeader(entry.timestamp)}${entry.message}`;
    }).join('');
}

async function checkProviderAndModelValid(provider: string, model: string): Promise<boolean> {
    if (!(SUPPORTED_PROVIDERS as readonly string[]).includes(provider)) {
        return false;
    }

    const models = await getModelCatalog(provider as SupportedProvider);

    return models.some((m) => m.id === model);
}
async function restoreFileContexts(chatFile: string, savedContexts: SavedFileContext[]): Promise<void> {
    for (const context of savedContexts) {
        try {
            const content = await fs.readFile(context.filePath, 'utf-8');
            const fileName = context.filePath.split('/').pop() || context.filePath;
            const ext = getFileExtension(fileName);

            let contextSummary = '';

            if (context.isPartial && context.startLine !== undefined && context.endLine !== undefined) {
                // Handle partial file context
                const lines = content.split('\n');
                const selectedLines = lines.slice(context.startLine - 1, context.endLine);
                const selectedText = selectedLines.join('\n');
                const lineRange = context.startLine === context.endLine
                    ? `line ${context.startLine}`
                    : `lines ${context.startLine}-${context.endLine}`;

                contextSummary = `📁 ${fileName} (${lineRange})\n\n\`\`\`${ext}\n// Selected from: ${context.filePath} (${lineRange})\n${selectedText}\n\`\`\`\n\n`;
            } else {
                // Handle full file context
                const lineCount = content.split('\n').length;
                contextSummary = `📁 ${fileName} (${lineCount} lines, ${Math.round(content.length / 1024)}KB)\n\n\`\`\`${ext}\n// Full file content loaded: ${context.filePath}\n// Use this file context in your responses\n// File contains ${lineCount} lines of ${ext} code\n\`\`\`\n\n`;
            }

            await fs.appendFile(chatFile, contextSummary);
        } catch (error) {
            console.error(`Error restoring context for ${context.filePath}:`, error);
        }
    }
}
