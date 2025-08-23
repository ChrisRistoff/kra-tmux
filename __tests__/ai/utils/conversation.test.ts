import * as fs from 'fs/promises';
import * as neovim from 'neovim';
import * as bash from '@/utils/bashHelper';
import { converse } from '@/AIchat/main/conversation';
import { promptModel } from '@/AIchat/utils/promptModel';
import { saveChat } from '@/AIchat/utils/saveChat';
import { openVim } from '@/utils/neovimHelper';
import { aiRoles } from '@/AIchat/data/roles';
import { formatChatEntry } from '@/AIchat/utils/aiUtils';
import { neovimConfig } from '@/filePaths';

jest.mock('fs/promises');
jest.mock('@/utils/bashHelper');
jest.mock('@/utils/neovimHelper');
jest.mock('@/AIchat/utils/promptModel');
jest.mock('@/AIchat/utils/saveChat');
jest.mock('@/AIchat/utils/aiUtils');
jest.mock('@/filePaths', () => ({
    neovimConfig: '/home/krasen/programming/kra-tmux/ai-files/init.lua'
}));

describe('converse', () => {
    const chatFile = 'chat.md';
    const temperature = 0.7;
    const role = 'testRole';
    const provider = 'providerA';
    const model = 'model1';

    let originalTmux: string | undefined;
    let fakeNvim: any;
    let nvimEvents: Record<string, Function>;

    beforeEach(() => {
        originalTmux = process.env.TMUX;
        delete process.env.TMUX;

        nvimEvents = {};
        fakeNvim = {
            command: jest.fn().mockResolvedValue(undefined),
            on: jest.fn((event: string, fn: Function) => {
                nvimEvents[event] = fn;
            }),
            buffer: Promise.resolve({
                lines: Promise.resolve(['USER message', '']),
            }),
            channelId: Promise.resolve(123),
        };

        jest.spyOn(neovim, 'attach').mockReturnValue(fakeNvim);

        (fs.access as jest.Mock).mockResolvedValue(undefined);

        (openVim as jest.Mock).mockClear();
        (bash.execCommand as jest.Mock).mockClear();
        (promptModel as jest.Mock).mockClear();
        (saveChat as jest.Mock).mockClear();
        (fs.writeFile as jest.Mock).mockClear();
        (fs.readFile as jest.Mock).mockClear();
        (fs.rm as jest.Mock).mockClear();

        (promptModel as jest.Mock).mockResolvedValue('AI response');
        (fs.readFile as jest.Mock).mockResolvedValue('Chat history content');
        (formatChatEntry as jest.Mock).mockImplementation((header: string) => header);
    });

    afterEach(() => {
        if (originalTmux !== undefined) {
            process.env.TMUX = originalTmux;
        } else {
            delete process.env.TMUX;
        }
        jest.restoreAllMocks();
    });

    it('should call openVim when TMUX is not set and process submit notification', async () => {
        await converse(chatFile, temperature, role, provider, model, false);

        expect(fs.writeFile).toHaveBeenCalledWith(
            chatFile,
            expect.stringContaining('# AI Chat History'),
            'utf-8'
        );

        expect(openVim).toHaveBeenCalled();
        const openVimCall = (openVim as jest.Mock).mock.calls[0];
        expect(openVimCall[0]).toBe(chatFile);
        expect(openVimCall[1]).toBe(`-u ${neovimConfig} --listen`);

        const socketPath = openVimCall[2];
        expect(socketPath).toMatch(/nvim-.*\.sock/);

        if (nvimEvents.notification) {
            await nvimEvents.notification('prompt_action', ['submit_pressed']);
        } else {
            throw new Error('Notification event handler not registered');
        }

        expect(promptModel).toHaveBeenCalledWith(
            provider,
            model,
            expect.stringContaining('USER message'),
            temperature,
            aiRoles[role],
            expect.objectContaining({
                abort: expect.any(Function),
                isAborted: expect.any(Boolean)
            })
        );

        if (nvimEvents.disconnect) {
            await nvimEvents.disconnect();
        } else {
            throw new Error('Disconnect event handler not registered');
        }

        expect(fs.readFile).toHaveBeenCalledWith(chatFile, 'utf8');
        expect(saveChat).toHaveBeenCalledWith(
            chatFile,
            provider,
            model,
            role,
            temperature,
            []
        );
        expect(fs.rm).toHaveBeenCalledWith(chatFile);
    });

    it('should execute tmux command when TMUX is set', async () => {
        process.env.TMUX = 'tmux';
        (bash.execCommand as jest.Mock).mockClear();
        (openVim as jest.Mock).mockClear();

        await converse(chatFile, temperature, role, provider, model, false);

        expect(bash.execCommand).toHaveBeenCalled();
        expect(openVim).not.toHaveBeenCalled();

        if (nvimEvents.notification) {
            await nvimEvents.notification('prompt_action', ['submit_pressed']);
        } else {
            throw new Error('Notification event handler not registered');
        }

        expect(promptModel).toHaveBeenCalledWith(
            provider,
            model,
            expect.stringContaining('USER message'),
            temperature,
            aiRoles[role],
            expect.objectContaining({
                abort: expect.any(Function),
                isAborted: expect.any(Boolean)
            })
        );

        if (nvimEvents.disconnect) {
            await nvimEvents.disconnect();
        } else {
            throw new Error('Disconnect event handler not registered');
        }
    });

    it('should process streaming responses from promptModel', async () => {
        async function* streamResponse() {
            yield 'chunk1 ';
            yield 'chunk2';
        }
        (promptModel as jest.Mock).mockResolvedValue(streamResponse());

        (fs.appendFile as jest.Mock).mockClear();
        (openVim as jest.Mock).mockClear();

        await converse(chatFile, temperature, role, provider, model, false);

        if (nvimEvents.notification) {
            await nvimEvents.notification('prompt_action', ['submit_pressed']);
        } else {
            throw new Error('Notification event handler not registered');
        }

        expect(promptModel).toHaveBeenCalledWith(
            provider,
            model,
            expect.stringContaining('USER message'),
            temperature,
            aiRoles[role],
            expect.objectContaining({
                abort: expect.any(Function),
                isAborted: expect.any(Boolean)
            })
        );

        if (nvimEvents.disconnect) {
            await nvimEvents.disconnect();
        } else {
            throw new Error('Disconnect event handler not registered');
        }

        expect(fs.appendFile).toHaveBeenCalled();
    });
});

