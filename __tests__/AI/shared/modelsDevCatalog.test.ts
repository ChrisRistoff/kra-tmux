import {
    formatCapabilitiesSummary,
} from '@/AI/shared/data/modelsDevCatalog';

describe('modelsDevCatalog', () => {
    describe('formatCapabilitiesSummary', () => {
        it('produces a non-empty summary with reasoning capabilities', () => {
            const info = {
                id: 'test-model',
                name: 'Test Model',
                provider: 'test',
                providerName: 'Test Provider',
                capabilities: {
                    reasoning: true,
                    reasoningField: 'reasoning_content' as const,
                    toolCall: true,
                    temperature: true,
                    structuredOutput: false,
                    attachment: true,
                    inputModalities: ['text', 'image'],
                    outputModalities: ['text'],
                    openWeights: true,
                },
                contextWindow: 128000,
                maxOutputTokens: 16384,
            };
            const summary = formatCapabilitiesSummary(info);
            expect(summary).toContain('Test Model');
            expect(summary).toContain('128k');
            expect(summary).toContain('Reasoning');
            expect(summary).toContain('reasoning_content');
            expect(summary).toContain('Tool calling');
            expect(summary).toContain('Open weights');
        });

        it('shows context window as ? when zero', () => {
            const info = {
                id: 'test',
                name: 'Test',
                provider: 'test',
                providerName: 'Test',
                capabilities: {
                    reasoning: false,
                    toolCall: false,
                    temperature: true,
                    structuredOutput: false,
                    attachment: false,
                    inputModalities: ['text'],
                    outputModalities: ['text'],
                },
                contextWindow: 0,
            };
            const summary = formatCapabilitiesSummary(info);
            expect(summary).toContain('?');
        });

        it('shows pricing with cached and reasoning breakdown', () => {
            const info = {
                id: 'test',
                name: 'Test',
                provider: 'test',
                providerName: 'Test',
                capabilities: {
                    reasoning: true,
                    toolCall: true,
                    temperature: true,
                    structuredOutput: true,
                    attachment: false,
                    inputModalities: ['text'],
                    outputModalities: ['text'],
                },
                pricing: {
                    inputPerM: 1.50,
                    outputPerM: 6.00,
                    cachedInputPerM: 0.30,
                    reasoningPerM: 10.00,
                },
                contextWindow: 128000,
            };
            const summary = formatCapabilitiesSummary(info);
            expect(summary).toContain('$1.50');
            expect(summary).toContain('$6.00');
            expect(summary).toContain('cached $0.30');
            expect(summary).toContain('reasoning $10.00');
        });

        it('shows reasoning_details as reasoning field for Gemini-style models', () => {
            const info = {
                id: 'gemini-3-flash',
                name: 'Gemini 3 Flash',
                provider: 'google',
                providerName: 'Google',
                capabilities: {
                    reasoning: true,
                    reasoningField: 'reasoning_details' as const,
                    toolCall: true,
                    temperature: true,
                    structuredOutput: true,
                    attachment: true,
                    inputModalities: ['text', 'image'],
                    outputModalities: ['text'],
                },
                contextWindow: 1000000,
            };
            const summary = formatCapabilitiesSummary(info);
            expect(summary).toContain('reasoning_details');
        });
    });
});