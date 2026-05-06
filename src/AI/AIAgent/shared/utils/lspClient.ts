/**
 * Generic Language Server Protocol client wrapper.
 *
 * Spawns an external LSP server (gopls, pyright, rust-analyzer, ...) as a
 * child process and speaks LSP JSON-RPC to it via vscode-languageserver-protocol.
 *
 * Lifecycle:
 *   const client = new LspClient(spec, workspaceRoot);
 *   await client.start();              // spawn + initialize + initialized
 *   await client.openFile(absPath);    // textDocument/didOpen (idempotent)
 *   const result = await client.sendRequest(HoverRequest.type, params);
 *   await client.shutdown();           // shutdown + exit + kill
 *
 * One client instance == one running language server == one (server, root)
 * pair. The registry decides when to spawn / reuse / shut down.
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import {
    createProtocolConnection,
    StreamMessageReader,
    StreamMessageWriter,
    ProtocolConnection,
    InitializeRequest,
    InitializedNotification,
    ShutdownRequest,
    ExitNotification,
    DidOpenTextDocumentNotification,
    DidChangeTextDocumentNotification,
    PublishDiagnosticsNotification,
    PublishDiagnosticsParams,
    InitializeParams,
    InitializeResult,
    TextDocumentSyncKind,
    Diagnostic,
} from 'vscode-languageserver-protocol/node.js';

export type LspServerSpec = {
    id: string;
    cmd: string;
    args: string[];
    env: Record<string, string> | undefined;
    initOptions: Record<string, unknown> | undefined;
    spawnTimeoutMs: number;
    requestTimeoutMs: number;
}

export type LanguageId = 'go' | 'python' | 'typescript' | 'typescriptreact' |
    'javascript' | 'javascriptreact' | 'rust' | 'java' | 'c' | 'cpp' |
    'csharp' | 'ruby' | 'php' | 'lua' | 'plaintext' | string;

const EXT_TO_LANGUAGE_ID: Record<string, LanguageId> = {
    '.go': 'go',
    '.py': 'python',
    '.pyi': 'python',
    '.ts': 'typescript',
    '.tsx': 'typescriptreact',
    '.mts': 'typescript',
    '.cts': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascriptreact',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.rs': 'rust',
    '.java': 'java',
    '.c': 'c',
    '.h': 'c',
    '.cc': 'cpp',
    '.cpp': 'cpp',
    '.cxx': 'cpp',
    '.hpp': 'cpp',
    '.cs': 'csharp',
    '.rb': 'ruby',
    '.php': 'php',
    '.lua': 'lua',
};

export function languageIdForFile(filePath: string): LanguageId {
    return EXT_TO_LANGUAGE_ID[path.extname(filePath).toLowerCase()] ?? 'plaintext';
}

export function fileUri(absPath: string): string {
    return pathToFileURL(absPath).href;
}

export function uriToPath(uri: string): string {
    try {
        return fileURLToPath(uri);
    } catch {
        return uri;
    }
}

type OpenDoc = {
    version: number;
    languageId: LanguageId;
    text: string;
}

export class LspClient {
    private readonly spec: LspServerSpec;
    private readonly workspaceRoot: string;
    private proc: ChildProcess | undefined;
    private connection: ProtocolConnection | undefined;
    private initResult: InitializeResult | undefined;
    private readonly openDocs = new Map<string, OpenDoc>();
    private readonly diagnostics = new Map<string, Diagnostic[]>();
    private startPromise: Promise<void> | undefined;
    private stopped = false;

    constructor(spec: LspServerSpec, workspaceRoot: string) {
        this.spec = spec;
        this.workspaceRoot = workspaceRoot;
    }

    get root(): string {
        return this.workspaceRoot;
    }

    get serverId(): string {
        return this.spec.id;
    }

    get capabilities(): InitializeResult['capabilities'] | undefined {
        return this.initResult?.capabilities;
    }

    isAlive(): boolean {
        return !this.stopped && this.proc !== undefined && this.proc.exitCode === null;
    }

    async start(): Promise<void> {
        if (this.startPromise) return this.startPromise;
        this.startPromise = this.doStart();

        return this.startPromise;
    }

    private async doStart(): Promise<void> {
        const proc = spawn(this.spec.cmd, this.spec.args, {
            cwd: this.workspaceRoot,
            env: this.spec.env ? { ...process.env, ...this.spec.env } : process.env,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.proc = proc;

        // Without an 'error' listener, a spawn failure (ENOENT, EACCES) emits
        // an uncaught error event that crashes the parent (the MCP server).
        proc.on('error', () => { this.stopped = true; });

        proc.stderr.on('data', () => { /* swallow; could be wired to a log file */ });
        // Stream 'error' events on stdin/stdout/stderr (e.g. EPIPE when the
        // child dies mid-write) are also fatal without a listener.
        proc.stderr.on('error', () => { this.stopped = true; });

        proc.on('exit', () => {
            this.stopped = true;
        });

        if (!proc.stdout || !proc.stdin) {
            throw new Error(`LSP ${this.spec.id}: failed to acquire stdio pipes`);
        }

        proc.stdin.on('error', () => { this.stopped = true; });
        proc.stdout.on('error', () => { this.stopped = true; });

        const connection = createProtocolConnection(
            new StreamMessageReader(proc.stdout),
            new StreamMessageWriter(proc.stdin),
        );
        this.connection = connection;

        connection.onNotification(PublishDiagnosticsNotification.type, (params: PublishDiagnosticsParams) => {
            this.diagnostics.set(uriToPath(params.uri), params.diagnostics);
        });

        connection.onUnhandledNotification(() => { /* noop */ });

        connection.listen();

        const initParams: InitializeParams = {
            processId: process.pid,
            clientInfo: { name: 'kra-agent-lsp', version: '0.1.0' },
            rootUri: fileUri(this.workspaceRoot),
            workspaceFolders: [{ uri: fileUri(this.workspaceRoot), name: path.basename(this.workspaceRoot) }],
            capabilities: {
                textDocument: {
                    synchronization: { didSave: true, dynamicRegistration: false },
                    hover: { contentFormat: ['markdown', 'plaintext'] },
                    definition: { linkSupport: true },
                    typeDefinition: { linkSupport: true },
                    implementation: { linkSupport: true },
                    references: {},
                    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
                    publishDiagnostics: { relatedInformation: true },
                    diagnostic: { dynamicRegistration: false, relatedDocumentSupport: true },
                    rename: { prepareSupport: true },
                },
                workspace: {
                    workspaceFolders: true,
                    configuration: false,
                    diagnostics: { refreshSupport: true },
                },
            },
            initializationOptions: this.spec.initOptions ?? null,
        };

        this.initResult = await this.withTimeout(
            connection.sendRequest(InitializeRequest.type, initParams),
            this.spec.spawnTimeoutMs,
            `${this.spec.id} initialize`,
        );

        connection.sendNotification(InitializedNotification.type, {}).catch(() => { /* server gone */ });
    }

    private async withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`LSP ${label} timed out after ${ms}ms`)), ms);
        });
        try {
            return await Promise.race([promise, timeout]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    async openFile(absPath: string): Promise<void> {
        if (!this.connection) throw new Error(`LSP ${this.spec.id} not started`);

        if (this.openDocs.has(absPath)) {
            await this.refreshFile(absPath);

            return;
        }

        const text = await fs.readFile(absPath, 'utf8');
        const languageId = languageIdForFile(absPath);
        this.openDocs.set(absPath, { version: 1, languageId, text });

        await this.connection.sendNotification(DidOpenTextDocumentNotification.type, {
            textDocument: {
                uri: fileUri(absPath),
                languageId,
                version: 1,
                text,
            },
        });
    }

    async refreshFile(absPath: string): Promise<void> {
        if (!this.connection) return;
        const doc = this.openDocs.get(absPath);
        if (!doc) {
            await this.openFile(absPath);

            return;
        }

        let text: string;
        try {
            text = await fs.readFile(absPath, 'utf8');
        } catch {
            return;
        }
        if (text === doc.text) return;

        doc.version += 1;
        doc.text = text;

        await this.connection.sendNotification(DidChangeTextDocumentNotification.type, {
            textDocument: { uri: fileUri(absPath), version: doc.version },
            contentChanges: [{ text }],
        });

        this.diagnostics.delete(absPath);
    }

    isOpen(absPath: string): boolean {
        return this.openDocs.has(absPath);
    }

    getOpenText(absPath: string): string | undefined {
        return this.openDocs.get(absPath)?.text;
    }

    async sendRequest<P, R>(type: { method: string }, params: P): Promise<R> {
        if (!this.connection) throw new Error(`LSP ${this.spec.id} not started`);

        return this.withTimeout(
            this.connection.sendRequest<R>(type.method as never, params as never),
            this.spec.requestTimeoutMs,
            `${this.spec.id} ${type.method}`,
        );
    }

    getCachedDiagnostics(absPath: string): Diagnostic[] | undefined {
        return this.diagnostics.get(absPath);
    }

    syncKind(): TextDocumentSyncKind {
        const sync = this.initResult?.capabilities.textDocumentSync;
        if (typeof sync === 'number') return sync;
        if (sync && typeof sync === 'object' && 'change' in sync && typeof sync.change === 'number') {
            return sync.change;
        }

        return TextDocumentSyncKind.Full;
    }

    async shutdown(): Promise<void> {
        if (this.stopped) return;
        this.stopped = true;
        const conn = this.connection;
        const proc = this.proc;
        try {
            if (conn) {
                await Promise.race([
                    conn.sendRequest(ShutdownRequest.type),
                    new Promise((resolve) => setTimeout(resolve, 1000)),
                ]);
                conn.sendNotification(ExitNotification.type).catch(() => { /* server already exiting */ });
                conn.dispose();
            }
        } catch {
            // Server might already be dead; fall through to kill.
        }
        if (proc && proc.exitCode === null) {
            proc.kill();
        }
    }
}
