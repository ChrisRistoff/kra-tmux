import { mergeExecutor, mergeInvestigator } from '@/AI/AIAgent/shared/subAgents/settings';

describe('mergeExecutor', () => {
    it('returns defaults when raw is undefined', () => {
        const merged = mergeExecutor(undefined);

        expect(merged.enabled).toBe(false);
        expect(merged.useInvestigatorRuntime).toBe(true);
        expect(merged.allowInterrupt).toBe(true);
        expect(merged.allowReplanEscape).toBe(true);
        expect(merged.includeDiffsInLog).toBe(true);
        expect(merged.maxToolCalls).toBe(60);
        expect(merged.toolWhitelist).toEqual(expect.arrayContaining(['read_lines', 'edit_lines', 'bash']));
    });

    it('respects partial overrides and falls back to defaults for the rest', () => {
        const merged = mergeExecutor({
            enabled: true,
            maxToolCalls: 100,
        });

        expect(merged.enabled).toBe(true);
        expect(merged.maxToolCalls).toBe(100);
        expect(merged.useInvestigatorRuntime).toBe(true);
        expect(merged.allowReplanEscape).toBe(true);
    });

    it('clamps maxToolCalls into the allowed range', () => {
        expect(mergeExecutor({ maxToolCalls: 0 }).maxToolCalls).toBe(1);
        expect(mergeExecutor({ maxToolCalls: 5000 }).maxToolCalls).toBe(500);
        expect(mergeExecutor({ maxToolCalls: 1.4 }).maxToolCalls).toBe(1);
        expect(mergeExecutor({ maxToolCalls: NaN as unknown as number }).maxToolCalls).toBe(60);
    });

    it('ignores non-boolean values for boolean fields', () => {
        const merged = mergeExecutor({
            enabled: 'yes' as unknown as boolean,
            useInvestigatorRuntime: 1 as unknown as boolean,
        });

        expect(merged.enabled).toBe(false);
        expect(merged.useInvestigatorRuntime).toBe(true);
    });

    it('filters non-string entries out of toolWhitelist', () => {
        const merged = mergeExecutor({
            toolWhitelist: ['read_lines', 42 as unknown as string, '', 'bash'],
        });

        expect(merged.toolWhitelist).toEqual(['read_lines', 'bash']);
    });

    it('falls back to defaults when toolWhitelist is empty after filtering', () => {
        const merged = mergeExecutor({
            toolWhitelist: ['', ''],
        });

        expect(merged.toolWhitelist).toEqual(expect.arrayContaining(['read_lines']));
    });

    it('handles non-object raw input', () => {
        const merged = mergeExecutor('garbage' as unknown as undefined);

        expect(merged.enabled).toBe(false);
        expect(merged.maxToolCalls).toBe(60);
    });
});

describe('mergeInvestigator', () => {
    it('returns defaults when raw is undefined', () => {
        const merged = mergeInvestigator(undefined);

        expect(merged.enabled).toBe(false);
        expect(merged.maxEvidenceItems).toBe(8);
        expect(merged.maxExcerptLines).toBe(20);
        expect(merged.validateExcerpts).toBe(true);
        expect(merged.toolWhitelist).toEqual(
            expect.arrayContaining(['semantic_search', 'read_lines', 'docs_search'])
        );
    });

    it('clamps maxEvidenceItems and maxExcerptLines into their allowed ranges', () => {
        const tooSmall = mergeInvestigator({ maxEvidenceItems: 0, maxExcerptLines: 0 });
        const tooLarge = mergeInvestigator({ maxEvidenceItems: 9999, maxExcerptLines: 9999 });

        expect(tooSmall.maxEvidenceItems).toBeGreaterThanOrEqual(1);
        expect(tooSmall.maxExcerptLines).toBeGreaterThanOrEqual(1);
        expect(tooLarge.maxEvidenceItems).toBeLessThanOrEqual(50);
        expect(tooLarge.maxExcerptLines).toBeLessThanOrEqual(200);
    });

    it('respects partial overrides', () => {
        const merged = mergeInvestigator({ enabled: true, validateExcerpts: false });

        expect(merged.enabled).toBe(true);
        expect(merged.validateExcerpts).toBe(false);
        expect(merged.maxEvidenceItems).toBe(8);
    });
});
