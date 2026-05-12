/**
 * Stage 1 visual POC for the chat TUI.
 *
 * Run: `node start.js --tui-chat-poc`
 *
 * Streams sample lorem text into the transcript pane so we can verify the
 * layout, focus ring, splitter resize and 30Hz render coalescing without
 * touching the real chat spawn path.
 */

import { createChatTuiApp } from '../chatTuiApp';

const SAMPLE = [
    '# Streaming demo',
    '',
    'Some **bold** text, some *italic*, some `inline code`, and a [link](https://example.com).',
    '',
    '## Subheading',
    '',
    '- first bullet with **emphasis**',
    '- second bullet with `code`',
    '  - nested bullet',
    '',
    '> A blockquote with _italic_ text.',
    '',
    '```ts',
    'export function hello(name: string): string {',
    '    return `hello, ${name}`;',
    '}',
    '```',
    '',
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
    '',
    '---',
    '',
    '1. ordered one',
    '2. ordered two',
    '',
].join('\n');

const TURN_GAP_MS = 800;
const CHUNK_MS = 18; // ~55Hz arrivals; the 30Hz scheduler will coalesce.

export async function runChatTuiPoc(): Promise<void> {
    const app = createChatTuiApp({
        title: 'chat (POC)',
        model: 'sample',
        onSubmit: (prompt) => {
            app.appendMarkdown(`\n> ${prompt.replace(/\n/g, '\n> ')}\n\n`);
            app.flushMarkdown();
            void streamSample(app, '(echo) ' + prompt + '\n\n' + SAMPLE);
        },
        onExit: () => {
            // No-op; POC only.
        },
    });

    // Seed something so the user sees the pane fill on launch.
    void streamSample(app, SAMPLE);

    await app.done();
}

async function streamSample(
    app: ReturnType<typeof createChatTuiApp>,
    text: string,
): Promise<void> {
    app.setStatus({ streaming: true });
    // Chunk the text into 1-8 char pieces, like a real LLM stream.
    let i = 0;
    while (i < text.length) {
        const n = 1 + Math.floor(Math.random() * 8);
        const piece = text.slice(i, i + n);
        i += n;
        app.appendMarkdown(piece);
        await sleep(CHUNK_MS);
    }
    app.flushMarkdown();
    app.appendMarkdown('\n');
    app.flushMarkdown();
    await sleep(TURN_GAP_MS);
    app.setStatus({ streaming: false });
}

async function sleep(ms: number): Promise<void> {
    return new Promise((res) => setTimeout(res, ms));
}

if (require.main === module) {
    runChatTuiPoc().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
