import {
    handleStopStream,
    generateSocketPath,
    waitForSocket,
    addNeovimFunctions,
    addCommands,
    setupKeyBindings,
    setupChatSplitLayout,
    getChatPromptText,
    clearChatPrompt,
    focusChatPrompt,
    refreshChatLayout,
    updateNvimAndGoToLastLine
} from '@/AI/shared/utils/conversationUtils/aiNeovimHelper';

import { StreamController } from '@/AI/shared/types/aiTypes';
import { NeovimClient } from "neovim";
import os from 'os';
import * as fs from 'fs/promises';

// Mock modules
jest.mock('os');
jest.mock('fs/promises');
jest.mock('@/utils/common', () => ({
    loadSettings: jest.fn(async () => ({})),
}));

// Mock StreamController
const mockStreamController = {
    isAborted: false,
    abort: jest.fn()
} as StreamController;

// Mock NeovimClient
const mockNvim = {
    command: jest.fn(),
    executeLua: jest.fn(),
} as unknown as jest.Mocked<NeovimClient>;

const mockedOs = jest.mocked(os);
const mockedFs = jest.mocked(fs);

describe('nvim-utils', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockStreamController.isAborted = false;
    });

    describe('handleStopStream', () => {
        it('should abort active stream and show stopped message', async () => {
            await handleStopStream(mockStreamController, mockNvim);

            expect(mockStreamController.abort).toHaveBeenCalled();
            expect(mockNvim.command).toHaveBeenCalledWith('echohl WarningMsg | echo "Generation stopped" | echohl None');
        });

        it('should show no active generation message when stream is already aborted', async () => {
            mockStreamController.isAborted = true;

            await handleStopStream(mockStreamController, mockNvim);

            expect(mockStreamController.abort).not.toHaveBeenCalled();
            expect(mockNvim.command).toHaveBeenCalledWith('echohl WarningMsg | echo "No active generation to stop" | echohl None');
        });

        it('should show no active generation message when no stream controller', async () => {
            await handleStopStream(null, mockNvim);

            expect(mockNvim.command).toHaveBeenCalledWith('echohl WarningMsg | echo "No active generation to stop" | echohl None');
        });
    });

    describe('generateSocketPath', () => {
        it('should generate socket path with random string', async () => {
            const mockTmpDir = '/tmp';
            mockedOs.tmpdir.mockReturnValue(mockTmpDir);

            const socketPath = await generateSocketPath();

            expect(socketPath).toMatch(/^\/tmp\/nvim-[a-z0-9]+\.sock$/);
            expect(os.tmpdir).toHaveBeenCalled();
        });

        describe('waitForSocket', () => {
            beforeEach(() => {
                jest.useFakeTimers();
            });

            afterEach(() => {
                jest.useRealTimers();
            });

            it('should return true when socket exists', async () => {
                mockedFs.access.mockResolvedValue(undefined);

                const promise = waitForSocket('/test/socket', 1000);
                const result = await promise;

                expect(result).toBe(true);
                expect(mockedFs.access).toHaveBeenCalledWith('/test/socket');
            });
        });

        describe('addNeovimFunctions', () => {
            it('should add all required VimL functions', async () => {
                const channelId = 123;

                await addNeovimFunctions(mockNvim, channelId);

                expect(mockNvim.command).toHaveBeenCalledTimes(6);
                expect(mockNvim.command).toHaveBeenCalledWith(expect.stringContaining('SaveAndSubmit()'));
                expect(mockNvim.command).toHaveBeenCalledWith(expect.stringContaining('g:kra_chat_prompt_buf'));
                expect(mockNvim.command).toHaveBeenCalledWith(expect.stringContaining('AddFileContext()'));
                expect(mockNvim.command).toHaveBeenCalledWith(expect.stringContaining('StopStream()'));
                expect(mockNvim.command).toHaveBeenCalledWith(expect.stringContaining('ShowFileContextsPopup()'));
                expect(mockNvim.command).toHaveBeenCalledWith(expect.stringContaining('RemoveFileContext()'));
                expect(mockNvim.command).toHaveBeenCalledWith(expect.stringContaining('ClearContexts()'));

                // Verify channel ID is properly interpolated
                expect(mockNvim.command).toHaveBeenCalledWith(expect.stringContaining(`rpcnotify(${channelId}`));
            });
        });

        describe('addCommands', () => {
            it('should add all required commands', async () => {
                await addCommands(mockNvim);

                expect(mockNvim.command).toHaveBeenCalledTimes(6);
                expect(mockNvim.command).toHaveBeenCalledWith('command! -nargs=0 SubmitPrompt call SaveAndSubmit()');
                expect(mockNvim.command).toHaveBeenCalledWith('command! -nargs=0 AddFile call AddFileContext()');
                expect(mockNvim.command).toHaveBeenCalledWith('command! -nargs=0 StopGeneration call StopStream()');
                expect(mockNvim.command).toHaveBeenCalledWith('command! -nargs=0 ClearContexts call ClearContexts()');
                expect(mockNvim.command).toHaveBeenCalledWith('command! -nargs=0 RemoveFileContext call RemoveFileContext()');
                expect(mockNvim.command).toHaveBeenCalledWith("command! -nargs=0 AgentToolHistory lua require('kra_agent.ui').show_history()");
            });
        });

        describe('setupKeyBindings', () => {
            it('should set up all key bindings', async () => {
                await setupKeyBindings(mockNvim);

                expect(mockNvim.executeLua).toHaveBeenCalledTimes(1);
                expect(mockNvim.executeLua).toHaveBeenCalledWith(
                    expect.stringContaining("map('n', '<CR>'"),
                    []
                );
            });
        });

        describe('chat split layout helpers', () => {
            it('should delegate chat prompt layout operations to the Lua module', async () => {
                const executeLuaMock = mockNvim.executeLua as unknown as jest.Mock;
                executeLuaMock
                    .mockResolvedValueOnce(undefined)
                    .mockResolvedValueOnce('Prompt text')
                    .mockResolvedValueOnce(undefined)
                    .mockResolvedValueOnce(undefined)
                    .mockResolvedValueOnce(undefined);

                await setupChatSplitLayout(mockNvim, 123, '/tmp/test-chat.md');
                expect(mockNvim.executeLua).toHaveBeenNthCalledWith(
                    1,
                    `require('kra_chat_layout').setup(...)`,
                    [123, '/tmp/test-chat.md', expect.objectContaining({
                        scroll_tick_ms: expect.any(Number),
                        scroll_acceleration: expect.any(Number),
                        append_debounce_ms: expect.any(Number),
                    })],
                );

                const prompt = await getChatPromptText(mockNvim);
                expect(prompt).toBe('Prompt text');
                expect(mockNvim.executeLua).toHaveBeenNthCalledWith(2, `return require('kra_chat_layout').get_prompt_text()`, []);

                await clearChatPrompt(mockNvim);
                expect(mockNvim.executeLua).toHaveBeenNthCalledWith(3, `require('kra_chat_layout').clear_prompt()`, []);

                await focusChatPrompt(mockNvim);
                expect(mockNvim.executeLua).toHaveBeenNthCalledWith(4, `require('kra_chat_layout').focus_prompt()`, []);

                await refreshChatLayout(mockNvim);
                expect(mockNvim.executeLua).toHaveBeenNthCalledWith(5, `require('kra_chat_layout').refresh()`, []);
            });

            it('should return an empty string when the prompt text is not a string', async () => {
                (mockNvim.executeLua as unknown as jest.Mock).mockResolvedValueOnce(123);

                await expect(getChatPromptText(mockNvim)).resolves.toBe('');
            });
        });

        describe('updateNvimAndGoToLastLine', () => {
            it('should refresh buffer, go to last line, and create new line', async () => {
                await updateNvimAndGoToLastLine(mockNvim);

                expect(mockNvim.command).toHaveBeenCalledTimes(3);
                expect(mockNvim.command).toHaveBeenNthCalledWith(1, 'edit!');
                expect(mockNvim.command).toHaveBeenNthCalledWith(2, 'normal! G');
                expect(mockNvim.command).toHaveBeenNthCalledWith(3, 'normal! o');
            });
        });
    });
});
