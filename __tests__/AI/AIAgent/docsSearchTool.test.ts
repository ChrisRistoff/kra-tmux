import { buildDocsSearchTool } from '@/AI/AIAgent/shared/utils/memoryMcpServer';
import type { DocsSource } from '@/types/settingsTypes';

describe('buildDocsSearchTool', () => {
    const sources: DocsSource[] = [
        { alias: 'lancedb', url: 'https://lancedb.github.io/lancedb/', description: 'LanceDB vector store.' },
        { alias: 'fastembed', url: 'https://github.com/qdrant/fastembed#readme' },
    ];

    it('constrains sourceAlias to a string enum of configured aliases', () => {
        const tool = buildDocsSearchTool(sources);
        const aliasProp = tool.inputSchema.properties.sourceAlias as { type: string, enum: string[] };
        expect(aliasProp.type).toBe('string');
        expect(aliasProp.enum).toEqual(['lancedb', 'fastembed']);
    });

    it('lists every configured source in the description with its description blurb', () => {
        const desc = buildDocsSearchTool(sources).description;
        expect(desc).toContain('Available sources');
        expect(desc).toContain('lancedb \u2014 LanceDB vector store.');
        expect(desc).toContain('fastembed \u2014 https://github.com/qdrant/fastembed#readme');
    });

    it('falls back to the URL when description is missing or whitespace', () => {
        const desc = buildDocsSearchTool([
            { alias: 'a', url: 'https://example.com/a' },
            { alias: 'b', url: 'https://example.com/b', description: '   ' },
        ]).description;
        expect(desc).toContain('a \u2014 https://example.com/a');
        expect(desc).toContain('b \u2014 https://example.com/b');
    });

    it('produces an empty enum when given no sources (caller is expected to skip registration)', () => {
        const tool = buildDocsSearchTool([]);
        const aliasProp = tool.inputSchema.properties.sourceAlias as { enum: string[] };
        expect(aliasProp.enum).toEqual([]);
    });

    it('keeps the base description text intact and required: query', () => {
        const tool = buildDocsSearchTool(sources);
        expect(tool.description).toContain('Vector search over the indexed documentation corpus');
        expect(tool.inputSchema.required).toEqual(['query']);
    });
});
