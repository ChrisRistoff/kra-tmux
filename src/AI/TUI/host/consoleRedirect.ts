import * as fsSync from 'fs';
import { Writable } from 'stream';

export interface ConsoleRedirectHandle {
    /**
     * A `Writable` that targets the *original* `process.stdout.write`,
     * captured before we monkey-patched it. Pass this to `blessed.screen({ output })`
     * so the TUI can keep rendering normally while everyone else's writes
     * (logs, deprecation warnings, byok stderr, MCP child stderr, etc.) go
     * to the log file and never touch the TTY.
     */
    blessedOutput: Writable;
    /** Restore the original `process.stdout/stderr.write` and `console.*`. */
    restore: () => void;
    /** Resolved log file path (`/tmp/kra-tmux-tui.log` unless `KRA_TUI_LOG` is set). */
    logPath: string;
    /**
     * Pipe a child process's stdout/stderr into the log file so its writes
     * never reach the TTY. Use this for any `child_process.fork`/`spawn`
     * that would otherwise be configured with `stdio: 'inherit'`. The
     * child must be spawned with `stdio: ['ignore'|'pipe', 'pipe', 'pipe', ...]`.
     */
    captureChild: (child: { stdout?: { pipe: (dest: Writable) => unknown } | null; stderr?: { pipe: (dest: Writable) => unknown } | null }) => void;
}

/**
 * Returns the active redirect handle if `installConsoleRedirect()` has been
 * called, otherwise `null`. Callers (child-process spawners, MCP transports)
 * use this to decide whether to capture child stdio into the log instead of
 * letting it inherit the parent TTY (which would bleed into blessed).
 */
export function getActiveConsoleRedirect(): ConsoleRedirectHandle | null {
    return installed;
}

let installed: ConsoleRedirectHandle | null = null;

/**
 * Quarantine every text write the agent / chat process performs so it
 * cannot bleed into the blessed framebuffer.
 *
 *  - All `console.*` writes are rerouted to the log file.
 *  - `process.stdout.write` and `process.stderr.write` are *also*
 *    rerouted — many libraries (byok session streaming, MCP child
 *    error reporting, deprecation warnings, the kra-memory watcher,
 *    etc.) write directly to those raw streams and would otherwise
 *    print AS RAW BYTES on top of the TUI, manifesting as ghost
 *    characters that survive scroll/redraw and as terminal-background
 *    bleed in pane gaps.
 *  - The original `process.stdout.write` is preserved and exposed
 *    through `blessedOutput` so blessed can still render to the TTY.
 *
 * Idempotent: returns the same handle on repeat calls within a process.
 */
export function installConsoleRedirect(): ConsoleRedirectHandle {
    if (installed) return installed;

    const logPath = process.env.KRA_TUI_LOG ?? '/tmp/kra-tmux-tui.log';

    let stream: fsSync.WriteStream | null = null;
    try {
        stream = fsSync.createWriteStream(logPath, { flags: 'a' });
    } catch {
        // If we can't open the log file, fall back to /dev/null-style
        // behaviour: silently drop writes rather than crash the TUI.
    }

    const writeLog = (chunk: unknown): void => {
        if (!stream) return;
        try {
            const s = typeof chunk === 'string' ? chunk : chunk instanceof Buffer ? chunk.toString('utf8') : String(chunk);
            stream.write(s);
        } catch {
            // ignore — never throw from a write hook
        }
    };

    const stamp = (): string => `[${new Date().toISOString()}] `;
    const fmt = (args: unknown[]): string =>
        args
            .map((a) => {
                if (typeof a === 'string') return a;
                try { return JSON.stringify(a); } catch { return String(a); }
            })
            .join(' ');

    // Save originals so we can (a) feed blessed and (b) restore on shutdown.
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    const origConsole = {
        log: console.log,
        info: console.info,
        warn: console.warn,
        error: console.error,
        debug: console.debug,
    };

    // Replace raw writes. Signature is overloaded; we accept anything and
    // always claim success (true) so callers don't see a different return
    // shape that could trip back-pressure logic.
    const patchedStdoutWrite: typeof process.stdout.write = ((
        chunk: unknown,
        encoding?: unknown,
        cb?: unknown,
    ): boolean => {
        writeLog(chunk);
        if (typeof encoding === 'function') (encoding as () => void)();
        else if (typeof cb === 'function') (cb as () => void)();

        return true;
    }) as typeof process.stdout.write;
    process.stdout.write = patchedStdoutWrite;
    process.stderr.write = patchedStdoutWrite as unknown as typeof process.stderr.write;

    const writeConsole = (level: string, args: unknown[]): void => {
        writeLog(`${stamp()}${level} ${fmt(args)}\n`);
    };
    console.log = (...a: unknown[]): void => writeConsole('LOG', a);
    console.info = (...a: unknown[]): void => writeConsole('INFO', a);
    console.warn = (...a: unknown[]): void => writeConsole('WARN', a);
    console.error = (...a: unknown[]): void => writeConsole('ERR', a);
    console.debug = (...a: unknown[]): void => writeConsole('DBG', a);

    // Stream blessed renders through the SAVED original stdout write so
    // the TUI keeps drawing while everyone else's writes are silenced.
    const blessedOutput = new Writable({
        write(chunk, _encoding, callback): void {
            try { origStdoutWrite(chunk); } catch { /* ignore */ }
            callback();
        },
    });
    // Blessed sometimes inspects `.columns` / `.rows` / `.isTTY` on its
    // output. Mirror them from the real stdout so size queries work.
    Object.defineProperty(blessedOutput, 'columns', { get: (): number => process.stdout.columns });
    Object.defineProperty(blessedOutput, 'rows', { get: (): number => process.stdout.rows });
    Object.defineProperty(blessedOutput, 'isTTY', { get: (): boolean => process.stdout.isTTY ?? false });

    const childLogSink = new Writable({
        write(chunk, _encoding, callback): void {
            writeLog(chunk);
            callback();
        },
    });

    const handle: ConsoleRedirectHandle = {
        blessedOutput,
        captureChild: (child) => {
            try { child.stdout?.pipe(childLogSink); } catch { /* ignore */ }
            try { child.stderr?.pipe(childLogSink); } catch { /* ignore */ }
        },
        restore: () => {
            process.stdout.write = origStdoutWrite;
            process.stderr.write = origStderrWrite;
            console.log = origConsole.log;
            console.info = origConsole.info;
            console.warn = origConsole.warn;
            console.error = origConsole.error;
            console.debug = origConsole.debug;
            try { stream?.end(); } catch { /* ignore */ }
            installed = null;
        },
        logPath,
    };
    installed = handle;

    return handle;
}

/**
 * Back-compat wrapper. Older call sites only need the redirect side-effect
 * (no custom blessed output). Returns the handle so callers can opt in.
 */
export function redirectConsoleToFile(): ConsoleRedirectHandle {
    return installConsoleRedirect();
}
