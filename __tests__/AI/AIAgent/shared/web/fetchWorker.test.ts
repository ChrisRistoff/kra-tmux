import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

import {
    getFetchWorker,
    _resetFetchWorker,
    _resetFetchWorkerConfigCache,
} from '@/AI/AIAgent/shared/web/fetchWorker';

jest.mock('@/AI/AIAgent/commands/docsSetup', () => ({
    isCrawl4aiInstalled: jest.fn(() => true),
}));

jest.mock('@/utils/common', () => ({
    loadSettings: jest.fn(async () => ({})),
}));

jest.mock('child_process', () => ({
    spawn: jest.fn(),
}));

import { spawn } from 'child_process';

interface FakeChild extends EventEmitter {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: jest.Mock;
    _stdinLines: string[];
    sendLine: (obj: Record<string, unknown>) => void;
    exit: (code: number, signal?: NodeJS.Signals | null) => void;
}

function createFakeChild(): FakeChild {
    const child = new EventEmitter() as FakeChild;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = jest.fn();
    child._stdinLines = [];
    child.stdin.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString('utf-8').split('\n')) {
            if (line.trim()) child._stdinLines.push(line);
        }
    });
    child.sendLine = (obj) => {
        child.stdout.write(JSON.stringify(obj) + '\n');
    };
    child.exit = (code, signal = null) => {
        child.emit('exit', code, signal);
    };
    return child;
}

const spawnMock = spawn as jest.Mock;

async function flush(times = 4): Promise<void> {
    for (let i = 0; i < times; i++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

describe('FetchWorker', () => {
    beforeEach(() => {
        spawnMock.mockReset();
        _resetFetchWorker();
        _resetFetchWorkerConfigCache();
    });

    afterEach(() => {
        _resetFetchWorker();
    });

    it('lazily spawns on first fetch and reuses the same child for the second', async () => {
        const child = createFakeChild();
        spawnMock.mockReturnValueOnce(child);

        const worker = getFetchWorker();
        const p1 = worker.fetch('https://example.test/a');

        // signal worker-ready then deliver fetch-result for request 1
        await flush();
        child.sendLine({ type: 'server-ready', pid: 12345 });
        await flush();
        child.sendLine({ type: 'fetch-result', requestId: '1', ok: true, markdown: '# A', title: 'A', status: 200, mode: 'browser' });

        const r1 = await p1;
        expect(r1.markdown).toBe('# A');
        expect(r1.coldStart).toBe(true);
        expect(spawnMock).toHaveBeenCalledTimes(1);

        // second call: no respawn
        const p2 = worker.fetch('https://example.test/b');
        await flush();
        child.sendLine({ type: 'fetch-result', requestId: '2', ok: true, markdown: '# B', title: 'B', status: 200, mode: 'browser' });
        const r2 = await p2;
        expect(r2.markdown).toBe('# B');
        expect(r2.coldStart).toBe(false);
        expect(spawnMock).toHaveBeenCalledTimes(1);
        expect(child._stdinLines.length).toBe(2);
        expect(JSON.parse(child._stdinLines[0]!)).toMatchObject({ requestId: '1', url: 'https://example.test/a' });
        expect(JSON.parse(child._stdinLines[1]!)).toMatchObject({ requestId: '2', url: 'https://example.test/b' });
    });

    it('rejects pending requests when the worker process exits unexpectedly', async () => {
        const child = createFakeChild();
        spawnMock.mockReturnValueOnce(child);

        const worker = getFetchWorker();
        const p = worker.fetch('https://example.test/dead');
        await flush();
        child.sendLine({ type: 'server-ready', pid: 1 });
        await flush();
        // crash before responding
        child.exit(1, null);

        await expect(p).rejects.toThrow(/exited code=1/);
    });

    it('respawns after the worker has died (next fetch starts a fresh child)', async () => {
        const child1 = createFakeChild();
        const child2 = createFakeChild();
        spawnMock.mockReturnValueOnce(child1).mockReturnValueOnce(child2);

        const worker = getFetchWorker();
        const p1 = worker.fetch('https://example.test/x');
        await flush();
        child1.sendLine({ type: 'server-ready', pid: 1 });
        await flush();
        child1.sendLine({ type: 'fetch-result', requestId: '1', ok: true, markdown: 'x', title: '', status: 200 });
        await p1;
        child1.exit(0, null);
        await flush();

        const p2 = worker.fetch('https://example.test/y');
        await flush();
        child2.sendLine({ type: 'server-ready', pid: 2 });
        await flush();
        child2.sendLine({ type: 'fetch-result', requestId: '2', ok: true, markdown: 'y', title: '', status: 200 });
        const r2 = await p2;
        expect(r2.markdown).toBe('y');
        expect(spawnMock).toHaveBeenCalledTimes(2);
    });

    it('forwards mode and pageTimeoutMs in the request payload', async () => {
        const child = createFakeChild();
        spawnMock.mockReturnValueOnce(child);

        const worker = getFetchWorker();
        const p = worker.fetch('https://example.test/m', { mode: 'browser', pageTimeoutMs: 5000 });
        await flush();
        child.sendLine({ type: 'server-ready', pid: 1 });
        await flush();
        child.sendLine({ type: 'fetch-result', requestId: '1', ok: true, markdown: 'ok', title: '', status: 200, mode: 'browser' });
        await p;
        const sent = JSON.parse(child._stdinLines[0]!);
        expect(sent).toEqual({ requestId: '1', url: 'https://example.test/m', mode: 'browser', pageTimeoutMs: 5000 });
    });

    it('propagates worker error payloads as rejections', async () => {
        const child = createFakeChild();
        spawnMock.mockReturnValueOnce(child);

        const worker = getFetchWorker();
        const p = worker.fetch('https://example.test/err');
        await flush();
        child.sendLine({ type: 'server-ready', pid: 1 });
        await flush();
        child.sendLine({ type: 'fetch-result', requestId: '1', ok: false, error: 'TimeoutError: page timeout' });

        await expect(p).rejects.toThrow(/TimeoutError/);
    });

    it('throws when crawl4ai is not installed (no spawn attempted)', async () => {
        const { isCrawl4aiInstalled } = require('@/AI/AIAgent/commands/docsSetup');
        (isCrawl4aiInstalled as jest.Mock).mockReturnValueOnce(false);

        const worker = getFetchWorker();
        await expect(worker.fetch('https://example.test/a')).rejects.toThrow(/not installed/);
        expect(spawnMock).not.toHaveBeenCalled();
    });
});
