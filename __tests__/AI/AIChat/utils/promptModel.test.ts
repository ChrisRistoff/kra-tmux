import OpenAI from 'openai';
import { promptModel } from '@/AI/AIChat/utils/promptModel';
import * as providers from '@/AI/shared/data/providers';

jest.mock('openai');
jest.mock('@/AI/shared/data/providers');

describe('promptModel', () => {
    const mockOpenAI = jest.mocked(OpenAI);
    const mockGetBaseURL = jest.mocked(providers.getProviderBaseURL);
    const mockGetApiKey = jest.mocked(providers.getProviderApiKey);

    function buildOpenAIInstance(stream: { [Symbol.asyncIterator]: () => AsyncIterator<unknown> }): { chat: { completions: { create: jest.Mock } } } {
        return {
            chat: {
                completions: {
                    create: jest.fn().mockResolvedValue(stream),
                },
            },
        };
    }

    function createMockStream(chunks: unknown[] = []): { [Symbol.asyncIterator]: () => AsyncIterator<unknown> } {
        return {
            async *[Symbol.asyncIterator]() {
                for (const chunk of chunks) {
                    yield chunk;
                }
            },
        };
    }

    beforeEach(() => {
        jest.clearAllMocks();
        mockGetApiKey.mockImplementation((p) => `${p}-key`);
        mockGetBaseURL.mockImplementation((p) => `https://${p}.example/v1`);
    });

    it.each(['deep-infra', 'deep-seek', 'open-router', 'gemini', 'open-ai', 'mistral'])(
        'initializes OpenAI client with shared provider config for %s',
        async (provider) => {
            const instance = buildOpenAIInstance(createMockStream());
            mockOpenAI.mockImplementation(() => instance as never);

            await promptModel(provider, 'model-x', 'test prompt', 0.7, 'test system');

            expect(mockGetApiKey).toHaveBeenCalledWith(provider);
            expect(mockGetBaseURL).toHaveBeenCalledWith(provider);
            expect(mockOpenAI).toHaveBeenCalledWith({
                apiKey: `${provider}-key`,
                baseURL: `https://${provider}.example/v1`,
            });
        }
    );

    it('passes the right messages, model, temperature, and stream flag', async () => {
        const instance = buildOpenAIInstance(createMockStream());
        mockOpenAI.mockImplementation(() => instance as never);

        await promptModel('deep-infra', 'gpt-3.5-turbo', 'test prompt', 0.7, 'test system');

        expect(instance.chat.completions.create).toHaveBeenCalledWith({
            messages: [
                { role: 'system', content: 'test system' },
                { role: 'user', content: 'test prompt\nRespond without adding chat entries, we format that on our end.' },
            ],
            model: 'gpt-3.5-turbo',
            temperature: 0.7,
            stream: true,
        });
    });

    it('yields text from stream chunks', async () => {
        const stream = createMockStream([
            { choices: [{ delta: { content: 'Hello' } }] },
            { choices: [{ delta: { content: ' world' } }] },
            { choices: [{ delta: { content: '!' } }] },
        ]);
        mockOpenAI.mockImplementation(() => buildOpenAIInstance(stream) as never);

        const result = await promptModel('open-ai', 'gpt-4', 'test', 0.7, 'system');
        const chunks: string[] = [];

        for await (const chunk of result) {
            chunks.push(chunk);
        }

        expect(chunks).toEqual(['Hello', ' world', '!']);
    });

    it('treats missing/null content as empty string', async () => {
        const stream = createMockStream([
            { choices: [{ delta: {} }] },
            { choices: [{ delta: { content: null } }] },
            { choices: [{ delta: { content: 'Hello' } }] },
        ]);
        mockOpenAI.mockImplementation(() => buildOpenAIInstance(stream) as never);

        const result = await promptModel('open-ai', 'gpt-4', 'test', 0.7, 'system');
        const chunks: string[] = [];

        for await (const chunk of result) {
            chunks.push(chunk);
        }

        expect(chunks).toEqual(['', '', 'Hello']);
    });
});
