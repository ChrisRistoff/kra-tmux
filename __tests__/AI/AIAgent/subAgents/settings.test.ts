import { mergeExecutor, mergeInvestigator, mergeTruncation } from '@/AI/AIAgent/shared/subAgents/settings';
import type { AgentTruncationSettings } from '@/AI/AIAgent/shared/subAgents/types';

describe('mergeExecutor', () => {
    it('returns defaults when raw is undefined', () => {
        const merged = mergeExecutor(undefined);

        expect(merged.enabled).toBe(false);
        expect(merged.useInvestigatorRuntime).toBe(true);
        expect(merged.allowInterrupt).toBe(true);
        expect(merged.allowReplanEscape).toBe(true);
        expect(merged.includeDiffsInLog).toBe(true);
        expect(merged.maxToolCalls).toBe(60);
        expect(merged.toolWhitelist).toEqual(expect.arrayContaining(['read_lines', 'anchor_edit', 'bash']));
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

        expect(merged.code).toBe(false);
        expect(merged.web).toBe(false);
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
        const merged = mergeInvestigator({ code: true, web: true, validateExcerpts: false });

        expect(merged.code).toBe(true);
        expect(merged.web).toBe(true);
        expect(merged.validateExcerpts).toBe(false);
        expect(merged.maxEvidenceItems).toBe(8);
    });

    it('treats `code` and `web` independently', () => {
        const onlyCode = mergeInvestigator({ code: true });
        const onlyWeb = mergeInvestigator({ web: true });

        expect(onlyCode.code).toBe(true);
        expect(onlyCode.web).toBe(false);
        expect(onlyWeb.code).toBe(false);
        expect(onlyWeb.web).toBe(true);
    });
});

describe('mergeTruncation', () => {
    const defaults: AgentTruncationSettings = {
        defaultHead: 4000,
        defaultTail: 4000,
        bashHead: 2000,
        bashTail: 6000,
        neverTruncate: ['semantic_search'],
    };

    it('returns a clone of defaults when raw is missing', () => {
        const merged = mergeTruncation(undefined, defaults);
        expect(merged).toEqual(defaults);
        expect(merged.neverTruncate).not.toBe(defaults.neverTruncate);
    });

    it('overrides only the specified fields', () => {
        const merged = mergeTruncation({ defaultHead: 1000, bashTail: 9999 }, defaults);
        expect(merged.defaultHead).toBe(1000);
        expect(merged.defaultTail).toBe(defaults.defaultTail);
        expect(merged.bashHead).toBe(defaults.bashHead);
        expect(merged.bashTail).toBe(9999);
    });

    it('clamps negative values to 0 and rejects non-numeric values', () => {
        const merged = mergeTruncation(
            { defaultHead: -50, defaultTail: 'nope' as unknown as number },
            defaults,
        );
        expect(merged.defaultHead).toBe(0);
        expect(merged.defaultTail).toBe(defaults.defaultTail);
    });

    it('replaces neverTruncate when provided and filters non-strings', () => {
        const merged = mergeTruncation(
            { neverTruncate: ['recall', '', 42 as unknown as string, 'docs_search'] },
            defaults,
        );
        expect(merged.neverTruncate).toEqual(['recall', 'docs_search']);
    });

    it('falls back to defaults when neverTruncate is omitted', () => {
        const merged = mergeTruncation({ defaultHead: 100 }, defaults);
        expect(merged.neverTruncate).toEqual(defaults.neverTruncate);
    });
});
