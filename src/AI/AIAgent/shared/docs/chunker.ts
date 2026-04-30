/**
 * Markdown-aware chunker for documentation pages.
 *
 * Goals (vs. the line-window chunker we use for code):
 *   - Respect heading hierarchy. We split on H1/H2/H3/H4 boundaries and
 *     carry a `sectionPath` ("Guide > Indexing > IVF_PQ") through to the
 *     resulting row metadata so retrieval can filter / display it.
 *   - Never split inside a fenced code block (```), HTML block (`<...>`),
 *     or a markdown table — these become atomic units even if oversized,
 *     to keep semantics intact.
 *   - Cap each chunk at a soft token budget (default ≈ 450 tokens for
 *     BGE-Small's 512-token context, leaving headroom for the prepended
 *     breadcrumb). When a section blows past the budget we split it on
 *     paragraph boundaries with a single-paragraph overlap.
 *   - Prepend the breadcrumb to the chunk content used for embedding so
 *     the vector picks up topical context, but keep the raw section text
 *     in `content` for snippet display.
 *
 * Token estimation is intentionally crude: we use a 4-chars-per-token
 * heuristic. BGE-Small uses WordPiece, but for budgeting purposes this
 * approximation is well within tolerance and avoids shipping a tokenizer.
 */

const DEFAULT_MAX_TOKENS = 450;
const CHARS_PER_TOKEN = 4;

export interface MarkdownChunk {
    sectionPath: string;
    content: string;
    contentForEmbedding: string;
    tokenCount: number;
}

export interface ChunkOptions {
    pageTitle?: string;
    maxTokens?: number;
}

export function chunkMarkdown(markdown: string, opts: ChunkOptions = {}): MarkdownChunk[] {
    const maxTokens = Math.max(64, opts.maxTokens ?? DEFAULT_MAX_TOKENS);
    const maxChars = maxTokens * CHARS_PER_TOKEN;

    const blocks = parseBlocks(markdown);
    const sections = groupBySection(blocks, opts.pageTitle ?? '');

    const out: MarkdownChunk[] = [];
    for (const section of sections) {
        for (const piece of splitSection(section, maxChars)) {
            const tokenCount = Math.ceil(piece.text.length / CHARS_PER_TOKEN);
            const breadcrumb = piece.sectionPath ? `# ${piece.sectionPath}\n\n` : '';
            out.push({
                sectionPath: piece.sectionPath,
                content: piece.text,
                contentForEmbedding: breadcrumb + piece.text,
                tokenCount,
            });
        }
    }

    return out;
}

interface MdBlock {
    kind: 'heading' | 'code' | 'html' | 'table' | 'paragraph' | 'blank';
    level?: number;
    text: string;
}

function parseBlocks(markdown: string): MdBlock[] {
    const lines = markdown.split('\n');
    const blocks: MdBlock[] = [];

    let i = 0;
    while (i < lines.length) {
        const line = lines[i];

        if (/^\s*$/.test(line)) {
            blocks.push({ kind: 'blank', text: '' });
            i += 1;
            continue;
        }

        const fenceMatch = /^(\s*)(```+|~~~+)(.*)$/.exec(line);
        if (fenceMatch) {
            const fence = fenceMatch[2];
            const buf: string[] = [line];
            i += 1;
            while (i < lines.length) {
                buf.push(lines[i]);
                if (lines[i].trimStart().startsWith(fence)) {
                    i += 1;
                    break;
                }
                i += 1;
            }
            blocks.push({ kind: 'code', text: buf.join('\n') });
            continue;
        }

        const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
        if (heading) {
            blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() });
            i += 1;
            continue;
        }

        if (/^\s*<[a-zA-Z][^>]*>/.test(line)) {
            const buf: string[] = [line];
            i += 1;
            while (i < lines.length && lines[i].trim() !== '') {
                buf.push(lines[i]);
                i += 1;
            }
            blocks.push({ kind: 'html', text: buf.join('\n') });
            continue;
        }

        if (/^\s*\|.*\|\s*$/.test(line)) {
            const buf: string[] = [line];
            i += 1;
            while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
                buf.push(lines[i]);
                i += 1;
            }
            blocks.push({ kind: 'table', text: buf.join('\n') });
            continue;
        }

        const buf: string[] = [line];
        i += 1;
        while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,6})\s+/.test(lines[i])) {
            const next = lines[i];
            if (/^(```+|~~~+)/.test(next.trimStart())) break;
            if (/^\s*<[a-zA-Z][^>]*>/.test(next)) break;
            if (/^\s*\|.*\|\s*$/.test(next)) break;
            buf.push(next);
            i += 1;
        }
        blocks.push({ kind: 'paragraph', text: buf.join('\n') });
    }

    return blocks;
}

interface MdSection {
    sectionPath: string;
    blocks: MdBlock[];
}

function groupBySection(blocks: MdBlock[], pageTitle: string): MdSection[] {
    const stack: { level: number, title: string }[] = [];
    const sections: MdSection[] = [];

    let current: MdSection = {
        sectionPath: pageTitle.trim(),
        blocks: [],
    };

    for (const block of blocks) {
        if (block.kind === 'heading') {
            if (current.blocks.length > 0) {
                sections.push(current);
            }
            const level = block.level ?? 1;
            while (stack.length > 0 && stack[stack.length - 1].level >= level) {
                stack.pop();
            }
            stack.push({ level, title: block.text });
            const path = [pageTitle.trim(), ...stack.map((s) => s.title)]
                .filter((s) => s.length > 0)
                .join(' > ');
            current = { sectionPath: path, blocks: [] };
        } else {
            current.blocks.push(block);
        }
    }
    if (current.blocks.length > 0) {
        sections.push(current);
    }

    return sections;
}

interface SectionPiece {
    sectionPath: string;
    text: string;
}

function splitSection(section: MdSection, maxChars: number): SectionPiece[] {
    const pieces: SectionPiece[] = [];
    const blocks = section.blocks.filter((b) => b.kind !== 'blank' || true);

    let buf: MdBlock[] = [];
    let bufChars = 0;
    let lastFlushedTail: MdBlock | null = null;

    const flush = (): void => {
        if (buf.length === 0) return;
        const text = renderBlocks(buf).trim();
        if (text.length > 0) {
            pieces.push({ sectionPath: section.sectionPath, text });
            const last = buf[buf.length - 1];
            lastFlushedTail = last && last.kind === 'paragraph' ? last : null;
        }
        buf = [];
        bufChars = 0;
    };

    for (const block of blocks) {
        const blockText = block.text;
        const blockChars = blockText.length + 1;

        const isAtomic = block.kind === 'code' || block.kind === 'html' || block.kind === 'table';

        if (isAtomic && blockChars > maxChars) {
            flush();
            pieces.push({ sectionPath: section.sectionPath, text: blockText });
            continue;
        }

        if (bufChars + blockChars > maxChars && buf.length > 0) {
            flush();
            if (lastFlushedTail !== null) {
                const tail: MdBlock = lastFlushedTail;
                buf.push(tail);
                bufChars += tail.text.length + 1;
                lastFlushedTail = null;
            }
        }

        buf.push(block);
        bufChars += blockChars;
    }

    flush();

    if (pieces.length === 0 && blocks.length > 0) {
        const text = renderBlocks(blocks).trim();
        if (text.length > 0) {
            pieces.push({ sectionPath: section.sectionPath, text });
        }
    }

    return pieces;
}

function renderBlocks(blocks: MdBlock[]): string {
    return blocks
        .map((b) => (b.kind === 'blank' ? '' : b.text))
        .join('\n\n')
        .replace(/\n{3,}/g, '\n\n');
}
