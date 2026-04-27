import type { NeovimClient } from 'neovim';
import { handleAddFileContext } from '@/AI/shared/utils/conversationUtils/fileContexts';
import * as fileContextPickers from '@/AI/shared/utils/conversationUtils/fileContextPickers';
import * as fileContextOps from '@/AI/shared/utils/conversationUtils/fileContextOps';

jest.mock('@/AI/shared/utils/conversationUtils/fileContextPickers', () => ({
    selectContextToRemove: jest.fn(),
    selectFileOrFolder: jest.fn(),
    promptShareMode: jest.fn(),
    selectFileFromFolder: jest.fn(),
}));

jest.mock('@/AI/shared/utils/conversationUtils/fileContextOps', () => ({
    addFolderContext: jest.fn(),
    addEntireFileContext: jest.fn(),
    addPartialFileContext: jest.fn(),
}));

describe('handleAddFileContext', () => {
    const mockCommand = jest.fn().mockResolvedValue(undefined);
    const mockNvimClient = {
        command: mockCommand,
    } as unknown as NeovimClient;

    const mockSelectFileOrFolder = jest.mocked(fileContextPickers.selectFileOrFolder);
    const mockPromptShareMode = jest.mocked(fileContextPickers.promptShareMode);
    const mockSelectFileFromFolder = jest.mocked(fileContextPickers.selectFileFromFolder);
    const mockAddFolderContext = jest.mocked(fileContextOps.addFolderContext);
    const mockAddEntireFileContext = jest.mocked(fileContextOps.addEntireFileContext);
    const mockAddPartialFileContext = jest.mocked(fileContextOps.addPartialFileContext);

    beforeEach(() => {
        jest.clearAllMocks();
        mockCommand.mockResolvedValue(undefined);
    });

    it('adds every selected file when entire mode is chosen', async () => {
        mockSelectFileOrFolder.mockResolvedValue([
            { path: '/repo/src/one.ts', isDir: false },
            { path: '/repo/src/two.ts', isDir: false },
        ]);
        mockPromptShareMode.mockResolvedValue('entire');

        await handleAddFileContext(mockNvimClient, '/tmp/chat.md');

        expect(mockAddEntireFileContext).toHaveBeenNthCalledWith(1, mockNvimClient, '/tmp/chat.md', '/repo/src/one.ts', undefined);
        expect(mockAddEntireFileContext).toHaveBeenNthCalledWith(2, mockNvimClient, '/tmp/chat.md', '/repo/src/two.ts', undefined);
        expect(mockAddPartialFileContext).not.toHaveBeenCalled();
        expect(mockAddFolderContext).not.toHaveBeenCalled();
    });

    it('adds every selected folder file and standalone file in snippet mode', async () => {
        mockSelectFileOrFolder.mockResolvedValue([
            { path: '/repo/src/components', isDir: true },
            { path: '/repo/src/app.ts', isDir: false },
        ]);
        mockPromptShareMode.mockResolvedValue('snippet');
        mockSelectFileFromFolder.mockResolvedValue([
            '/repo/src/components/Button.tsx',
            '/repo/src/components/Card.tsx',
        ]);

        await handleAddFileContext(mockNvimClient, '/tmp/chat.md', { agentMode: true });

        expect(mockSelectFileFromFolder).toHaveBeenCalledWith(mockNvimClient, '/repo/src/components');
        expect(mockAddPartialFileContext).toHaveBeenNthCalledWith(1, mockNvimClient, '/tmp/chat.md', '/repo/src/components/Button.tsx', true);
        expect(mockAddPartialFileContext).toHaveBeenNthCalledWith(2, mockNvimClient, '/tmp/chat.md', '/repo/src/components/Card.tsx', true);
        expect(mockAddPartialFileContext).toHaveBeenNthCalledWith(3, mockNvimClient, '/tmp/chat.md', '/repo/src/app.ts', true);
        expect(mockAddEntireFileContext).not.toHaveBeenCalled();
    });
});
