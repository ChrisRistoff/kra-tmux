import {
    fileContexts,
    clearFileContexts,
    getFileExtension,
    getFileContextsForPrompt,
    rebuildFileContextsFromChat,
    showFileContextsPopup,
} from '@/AIchat/utils/conversationUtils/fileContexts';
import { FileContext } from '@/AIchat/types/aiTypes';
import { NeovimClient } from 'neovim';
import fs from 'fs/promises';

jest.mock('fs/promises');

jest.mock('@/AIchat/data/filetypes', () => ({
    fileTypes: {
        ts: 'typescript',
        js: 'javascript',
        txt: 'text'
    }
}));

const mockNvimClient = {
    command: jest.fn(),
    channelId: Promise.resolve(1),
    on: jest.fn(),
    removeListener: jest.fn(),
    executeLua: jest.fn(),
    setVar: jest.fn(),
    getVar: jest.fn(),
    call: jest.fn()
} as unknown as NeovimClient;

describe('fileContexts', () => {
    const testFilePath = '/test/file.ts';
    const testFileContent = 'console.log("test");\nconst x = 1;\n';

    beforeEach(() => {
        fileContexts.length = 0;
        jest.clearAllMocks();
        (fs.readFile as jest.Mock).mockResolvedValue(testFileContent);
    });

    describe('clearFileContexts', () => {
        it('should clear all file contexts', () => {
            fileContexts.push({ filePath: testFilePath, isPartial: false } as FileContext);
            expect(fileContexts).toHaveLength(1);

            clearFileContexts();
            expect(fileContexts).toHaveLength(0);
        });
    });

    describe('getFileExtension', () => {
        it('should return correct extension for known file types', () => {
            expect(getFileExtension('file.ts')).toBe('typescript');
            expect(getFileExtension('file.js')).toBe('javascript');
        });

        it('should return file extension for unknown types', () => {
            expect(getFileExtension('file.unknown')).toBe('unknown');
        });

        it('should return text for files without extension', () => {
            expect(getFileExtension('README')).toBe('text');
        });
    });

    describe('getFileContextsForPrompt', () => {
        it('should return empty string when no contexts exist', async () => {
            const result = await getFileContextsForPrompt();
            expect(result).toBe('');
        });

        it('should generate context string for full file contexts', async () => {
            fileContexts.push({
                filePath: testFilePath,
                isPartial: false
            } as FileContext);

            const result = await getFileContextsForPrompt();
            expect(result).toContain('--- FILE CONTEXTS ---');
            expect(result).toContain('The following files have been provided as context for this conversation');
            expect(result).toContain(testFilePath);
            expect(result).toContain(testFileContent);
        });

        it('should handle file read errors gracefully', async () => {
            (fs.readFile as jest.Mock).mockRejectedValue(new Error('File not found'));
            fileContexts.push({
                filePath: testFilePath,
                isPartial: false
            } as FileContext);

            const result = await getFileContextsForPrompt();
            expect(result).toContain('Error: Could not load file');
        });

        it('should skip partial file contexts', async () => {
            fileContexts.push({
                filePath: testFilePath,
                isPartial: true,
                startLine: 1,
                endLine: 2
            } as FileContext);

            const result = await getFileContextsForPrompt();
            expect(result).toBe('\n\n--- FILE CONTEXTS ---\nThe following files have been provided as context for this conversation:\n\n');
        });
    });

    describe('rebuildFileContextsFromChat', () => {
        it('should rebuild full file contexts from chat content', async () => {
            const chatContent = `Some chat content
📁 file.ts (544 lines, 23KB)
\`\`\`typescript
// Full file content loaded: /test/file.ts
// Use this file context in your responses
// File contains 544 lines of typescript code
\`\`\``;
            (fs.readFile as jest.Mock).mockResolvedValue(chatContent);

            await rebuildFileContextsFromChat('/test/chat.md');

            expect(fileContexts).toHaveLength(1);
            expect(fileContexts[0]).toEqual({
                filePath: '/test/file.ts',
                isPartial: false,
                summary: 'Full file:  file.ts'
            });
        });

        it('should rebuild partial file contexts from chat content', async () => {
            const chatContent = `📁 file.ts (lines 1-3)
\`\`\`typescript
// Selected from: /test/file.ts (lines 1-3)
console.log("test");
\`\`\``;
            (fs.readFile as jest.Mock).mockResolvedValue(chatContent);

            await rebuildFileContextsFromChat('/test/chat.md');

            expect(fileContexts).toHaveLength(1);
            expect(fileContexts[0]).toEqual({
                filePath: '/test/file.ts',
                isPartial: true,
                startLine: 1,
                endLine: 3,
                summary: 'Partial file:  file.ts'
            });
        });

        it('should handle single line selections', async () => {
            const chatContent = `📁 file.ts (line 5)
\`\`\`typescript
// Selected from: /test/file.ts (line 5)
const x = 1;
\`\`\``;
            (fs.readFile as jest.Mock).mockResolvedValue(chatContent);

            await rebuildFileContextsFromChat('/test/chat.md');

            expect(fileContexts).toHaveLength(1);
            expect(fileContexts[0]).toEqual({
                filePath: '/test/file.ts',
                isPartial: true,
                startLine: 5,
                endLine: 5,
                summary: 'Partial file:  file.ts'
            });
        });

        it('should handle file read errors', async () => {
            (fs.readFile as jest.Mock).mockRejectedValue(new Error('File not found'));

            await expect(rebuildFileContextsFromChat('/test/chat.md')).resolves.not.toThrow();
            expect(fileContexts).toHaveLength(0);
        });

        it('should handle empty chat file', async () => {
            (fs.readFile as jest.Mock).mockResolvedValue('');

            await rebuildFileContextsFromChat('/test/chat.md');
            expect(fileContexts).toHaveLength(0);
        });
    });

    describe('showFileContextsPopup', () => {
        it('should show warning when no contexts exist', async () => {
            await showFileContextsPopup(mockNvimClient);
            expect(mockNvimClient.command).toHaveBeenCalledWith(
                expect.stringContaining('No file contexts currently loaded')
            );
        });

        it('should show full file context in popup', async () => {
            fileContexts.push({
                filePath: testFilePath,
                isPartial: false
            } as FileContext);

            await showFileContextsPopup(mockNvimClient);
            expect(mockNvimClient.executeLua).toHaveBeenCalled();
        });

        it('should show partial file context in popup', async () => {
            fileContexts.push({
                filePath: testFilePath,
                isPartial: true,
                startLine: 1,
                endLine: 3
            } as FileContext);

            await showFileContextsPopup(mockNvimClient);
            expect(mockNvimClient.executeLua).toHaveBeenCalled();
        });

        it('should handle file read errors in popup', async () => {
            (fs.readFile as jest.Mock).mockRejectedValue(new Error('File not found'));
            fileContexts.push({
                filePath: testFilePath,
                isPartial: false
            } as FileContext);

            await showFileContextsPopup(mockNvimClient);
            expect(mockNvimClient.executeLua).toHaveBeenCalled();
        });

        it('should fallback to echo when popup fails', async () => {
            (mockNvimClient.executeLua as jest.Mock).mockRejectedValue(new Error('Popup failed'));
            fileContexts.push({
                filePath: testFilePath,
                isPartial: false
            } as FileContext);

            await showFileContextsPopup(mockNvimClient);
            expect(mockNvimClient.command).toHaveBeenCalledWith(
                expect.stringContaining('Loaded contexts:')
            );
        });
    });
});

