import * as keys from '@/AIchat/data/keys';
import { Mistral } from '@mistralai/mistralai';
import OpenAI from "openai";
import { promptModel } from '@/AIchat/utils/promptModel';

jest.mock('@/AIchat/data/keys');
jest.mock('@mistralai/mistralai');
jest.mock('openai');

describe('AI Chat Model Operations', () => {
    const mockGetDeepInfraKey = jest.mocked(keys.getDeepInfraKey);
    const mockGetDeepSeekKey = jest.mocked(keys.getDeepSeekKey);
    const mockGetOpenRouterKey = jest.mocked(keys.getOpenRouterKey);
    const mockGetGeminiKey = jest.mocked(keys.getGeminiKey);
    const mockGetMistralKey = jest.mocked(keys.getMistralKey);

    const mockOpenAI = jest.mocked(OpenAI);
    const mockMistral = jest.mocked(Mistral);

    beforeEach(() => {
        jest.clearAllMocks();

        // default key returns
        mockGetDeepInfraKey.mockReturnValue('deep-infra-key');
        mockGetDeepSeekKey.mockReturnValue('deep-seek-key');
        mockGetOpenRouterKey.mockReturnValue('open-router-key');
        mockGetGeminiKey.mockReturnValue('gemini-key');
        mockGetMistralKey.mockReturnValue('mistral-key');
    });

    describe('promptModel', () => {
        describe('deep-infra provider', () => {
            it('should initialize OpenAI client with deep-infra configuration', async () => {
                const mockStream = createMockOpenAIStream();
                const mockOpenAIInstance = {
                    chat: {
                        completions: {
                            create: jest.fn().mockResolvedValue(mockStream)
                        }
                    }
                };
                mockOpenAI.mockImplementation(() => mockOpenAIInstance as any);

                await promptModel('deep-infra', 'gpt-3.5-turbo', 'test prompt', 0.7, 'test system');

                expect(mockOpenAI).toHaveBeenCalledWith({
                    apiKey: 'deep-infra-key',
                    baseURL: 'https://api.deepinfra.com/v1/openai'
                });

                expect(mockGetDeepInfraKey).toHaveBeenCalled();
            });

            it('should call OpenAI stream with correct parameters', async () => {
                const mockStream = createMockOpenAIStream();
                const mockOpenAIInstance = {
                    chat: {
                        completions: {
                            create: jest.fn().mockResolvedValue(mockStream)
                        }
                    }
                };
                mockOpenAI.mockImplementation(() => mockOpenAIInstance as any);

                await promptModel('deep-infra', 'gpt-3.5-turbo', 'test prompt', 0.7, 'test system');

                expect(mockOpenAIInstance.chat.completions.create).toHaveBeenCalledWith({
                    messages: [
                        { role: "system", content: "test system" },
                        { role: "user", content: "test prompt\nRespond without adding chat entries, we format that on our end." }
                    ],
                    model: 'gpt-3.5-turbo',
                    temperature: 0.7,
                    stream: true
                });
            });
        });

        describe('deep-seek provider', () => {
            it('should initialize OpenAI client with deep-seek configuration', async () => {
                const mockStream = createMockOpenAIStream();
                const mockOpenAIInstance = {
                    chat: {
                        completions: {
                            create: jest.fn().mockResolvedValue(mockStream)
                        }
                    }
                };
                mockOpenAI.mockImplementation(() => mockOpenAIInstance as any);

                await promptModel('deep-seek', 'deepseek-chat', 'test prompt', 0.5, 'test system');

                expect(mockOpenAI).toHaveBeenCalledWith({
                    baseURL: 'https://api.deepseek.com/v1',
                    apiKey: 'deep-seek-key'
                });
                expect(mockGetDeepSeekKey).toHaveBeenCalled();
            });
        });

        describe('open-router provider', () => {
            it('should initialize OpenAI client with open-router configuration', async () => {
                const mockStream = createMockOpenAIStream();
                const mockOpenAIInstance = {
                    chat: {
                        completions: {
                            create: jest.fn().mockResolvedValue(mockStream)
                        }
                    }
                };
                mockOpenAI.mockImplementation(() => mockOpenAIInstance as any);

                await promptModel('open-router', 'gpt-4', 'test prompt', 0.8, 'test system');

                expect(mockOpenAI).toHaveBeenCalledWith({
                    baseURL: 'https://openrouter.ai/api/v1',
                    apiKey: 'open-router-key'
                });
                expect(mockGetOpenRouterKey).toHaveBeenCalled();
            });
        });

        describe('gemini provider', () => {
            it('should initialize OpenAI client with gemini configuration', async () => {
                const mockStream = createMockOpenAIStream();
                const mockOpenAIInstance = {
                    chat: {
                        completions: {
                            create: jest.fn().mockResolvedValue(mockStream)
                        }
                    }
                };
                mockOpenAI.mockImplementation(() => mockOpenAIInstance as any);

                await promptModel('gemini', 'gemini-pro', 'test prompt', 0.9, 'test system');

                expect(mockOpenAI).toHaveBeenCalledWith({
                    apiKey: 'gemini-key',
                    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/'
                });
                expect(mockGetGeminiKey).toHaveBeenCalled();
            });
        });

        describe('mistral provider', () => {
            it('should initialize Mistral client and create stream', async () => {
                const mockMistralStream = createMockMistralStream();
                const mockMistralInstance = {
                    chat: {
                        stream: jest.fn().mockResolvedValue(mockMistralStream)
                    }
                };
                mockMistral.mockImplementation(() => mockMistralInstance as any);

                const result = await promptModel('mistral', 'mistral-medium', 'test prompt', 0.6, 'test system');

                expect(mockMistral).toHaveBeenCalledWith({
                    apiKey: 'mistral-key'
                });
                expect(mockGetMistralKey).toHaveBeenCalled();

                const chunks = [];
                for await (const chunk of result) {
                    chunks.push(chunk);
                }

                expect(mockMistralInstance.chat.stream).toHaveBeenCalledWith({
                    model: 'mistral-medium',
                    messages: [
                        { role: 'system', content: 'test system' },
                        { role: 'user', content: 'test prompt\nRespond without adding chat entries, we format that on our end.' }
                    ],
                    stream: true
                });
            });
        });

        describe('open-ai provider (default)', () => {
            it('should initialize default OpenAI client for open-ai provider', async () => {
                const mockStream = createMockOpenAIStream();
                const mockOpenAIInstance = {
                    chat: {
                        completions: {
                            create: jest.fn().mockResolvedValue(mockStream)
                        }
                    }
                };
                mockOpenAI.mockImplementation(() => mockOpenAIInstance as any);

                await promptModel('open-ai', 'gpt-4', 'test prompt', 0.7, 'test system');

                expect(mockOpenAI).toHaveBeenCalledWith();
            });

            it('should use default provider when unknown provider is given', async () => {
                const mockStream = createMockOpenAIStream();
                const mockOpenAIInstance = {
                    chat: {
                        completions: {
                            create: jest.fn().mockResolvedValue(mockStream)
                        }
                    }
                };
                mockOpenAI.mockImplementation(() => mockOpenAIInstance as any);

                await promptModel('unknown-provider', 'gpt-4', 'test prompt', 0.7, 'test system');

                expect(mockOpenAI).toHaveBeenCalledWith();
            });
        });
    });

    describe('OpenAI Stream', () => {
        it('should yield text content from OpenAI stream chunks', async () => {
            const mockStream = createMockOpenAIStream([
                { choices: [{ delta: { content: 'Hello' } }] },
                { choices: [{ delta: { content: ' world' } }] },
                { choices: [{ delta: { content: '!' } }] }
            ]);

            const mockOpenAIInstance = {
                chat: {
                    completions: {
                        create: jest.fn().mockResolvedValue(mockStream)
                    }
                }
            };
            mockOpenAI.mockImplementation(() => mockOpenAIInstance as any);

            const result = await promptModel('deep-infra', 'gpt-3.5-turbo', 'test', 0.7, 'system');
            const chunks = [];

            for await (const chunk of result) {
                chunks.push(chunk);
            }

            expect(chunks).toEqual(['Hello', ' world', '!']);
        });

        it('should handle empty content in OpenAI stream chunks', async () => {
            const mockStream = createMockOpenAIStream([
                { choices: [{ delta: {} }] },
                { choices: [{ delta: { content: null } }] },
                { choices: [{ delta: { content: 'Hello' } }] }
            ]);

            const mockOpenAIInstance = {
                chat: {
                    completions: {
                        create: jest.fn().mockResolvedValue(mockStream)
                    }
                }
            };
            mockOpenAI.mockImplementation(() => mockOpenAIInstance as any);

            const result = await promptModel('deep-infra', 'gpt-3.5-turbo', 'test', 0.7, 'system');
            const chunks = [];

            for await (const chunk of result) {
                chunks.push(chunk);
            }

            expect(chunks).toEqual(['', '', 'Hello']);
        });
    });

    describe('Mistral Stream', () => {
        it('should yield text content from Mistral stream chunks', async () => {
            const mockMistralStream = createMockMistralStream([
                { data: { choices: [{ delta: { content: 'Hello' } }] } },
                { data: { choices: [{ delta: { content: ' from' } }] } },
                { data: { choices: [{ delta: { content: ' Mistral' } }] } }
            ]);

            const mockMistralInstance = {
                chat: {
                    stream: jest.fn().mockResolvedValue(mockMistralStream)
                }
            };
            mockMistral.mockImplementation(() => mockMistralInstance as any);

            const result = await promptModel('mistral', 'mistral-medium', 'test', 0.7, 'system');
            const chunks = [];

            for await (const chunk of result) {
                chunks.push(chunk);
            }

            expect(chunks).toEqual(['Hello', ' from', ' Mistral']);
        });

        it('should handle array content in Mistral stream chunks', async () => {
            const mockMistralStream = createMockMistralStream([
                { data: { choices: [{ delta: { content: ['Hello', ' world'] } }] } },
                { data: { choices: [{ delta: { content: ['!'] } }] } }
            ]);

            const mockMistralInstance = {
                chat: {
                    stream: jest.fn().mockResolvedValue(mockMistralStream)
                }
            };
            mockMistral.mockImplementation(() => mockMistralInstance as any);

            const result = await promptModel('mistral', 'mistral-medium', 'test', 0.7, 'system');
            const chunks = [];

            for await (const chunk of result) {
                chunks.push(chunk);
            }

            expect(chunks).toEqual(['Hello world', '!']);
        });

        it('should handle null/undefined content in Mistral stream chunks', async () => {
            const mockMistralStream = createMockMistralStream([
                { data: { choices: [{ delta: { content: null } }] } },
                { data: { choices: [{ delta: {} }] } },
                { data: { choices: [{ delta: { content: 'Hello' } }] } }
            ]);

            const mockMistralInstance = {
                chat: {
                    stream: jest.fn().mockResolvedValue(mockMistralStream)
                }
            };
            mockMistral.mockImplementation(() => mockMistralInstance as any);

            const result = await promptModel('mistral', 'mistral-medium', 'test', 0.7, 'system');
            const chunks = [];

            for await (const chunk of result) {
                chunks.push(chunk);
            }

            expect(chunks).toEqual(['', '', 'Hello']);
        });
    });

    // elpers to create mock streams
    function createMockOpenAIStream(chunks: any[] = []) {
        return {
            async *[Symbol.asyncIterator]() {
                for (const chunk of chunks) {
                    yield chunk;
                }
            }
        };
    }

    function createMockMistralStream(chunks: any[] = []) {
        return {
            async *[Symbol.asyncIterator]() {
                for (const chunk of chunks) {
                    yield chunk;
                }
            }
        };
    }
});
