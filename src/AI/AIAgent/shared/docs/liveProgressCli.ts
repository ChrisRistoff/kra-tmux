/**
 * Standalone CLI entrypoint that runs the multi-pane live crawl progress
 * screen. Spawned by the `kra memory` docs section via `runInherit` so the
 * blessed screen owns the tty cleanly (two blessed screens cannot share the
 * same tty inside a single process — attempting that freezes the terminal).
 */

import 'module-alias/register';

import { showLiveProgress } from './liveProgressScreen';

async function main(): Promise<void> {
    try {
        await showLiveProgress();
    } catch (err) {
        process.stderr.write(`live progress failed: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
    }
    process.exit(0);
}

void main();
