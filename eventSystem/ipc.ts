import fs from 'fs';
import net from 'net';
import { spawn } from 'child_process';

export enum IPCsockets {
    AutosaveSocket = '/tmp/autosave.sock',
}

export enum IPCEvents {
    FlushAutosave = 'flush-autosave',
}

export interface IPCServer {
    addListener: (handler: (event: string) => void) => Promise<void>;
    close: () => void;
}

export interface IPCClient {
    emit: (event: string) => Promise<void>;
    ensureServerRunning: (serverScript: string) => Promise<void>;
}

export function createIPCServer(socketPath: string): IPCServer {
    let server: net.Server | undefined;
    let eventHandler: ((event: string) => void) | undefined;
    const pidFile = `${socketPath}.pid`;

    const cleanup = () => {
        if (server) {
            server.close();
            server = undefined;
        }

        try {
            if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
            if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
        } catch (e) {
            // ignore cleanup errors
        }
    };

    const addListener = (handler: (event: string) => void): Promise<void> => {
        return new Promise((resolve, reject) => {
            eventHandler = handler;

            // clean up existing socket if it exists
            if (fs.existsSync(socketPath)) {
                fs.unlinkSync(socketPath);
            }

            server = net.createServer((socket) => {
                socket.on('data', (data) => {
                    const message = data.toString().trim();
                    if (message && eventHandler) {
                        eventHandler(message);
                    }
                });

                socket.on('error', (err) => {
                    console.error('Socket client error:', err);
                });

                socket.on('close', () => {
                    // Client disconnected
                });
            });

            server.on('error', (err: NodeJS.ErrnoException) => {
                if (err.code === 'EADDRINUSE') {
                    // socket already in use, try to clean it up
                    cleanup();
                    setTimeout(() => {
                        // retry after cleanup
                        addListener(handler).then(resolve).catch(reject);
                    }, 100);
                    return;
                }
                reject(err);
            });

            server.listen(socketPath, () => {
                // write PID file so client knows we're running
                fs.writeFileSync(pidFile, process.pid.toString());

                // set socket permissions (owner read/write only for security)
                fs.chmodSync(socketPath, 0o600);

                resolve();
            });

            // cleanup on exit
            process.on('exit', cleanup);
            process.on('SIGINT', () => { cleanup(); process.exit(0); });
            process.on('SIGTERM', () => { cleanup(); process.exit(0); });
        });
    };

    const close = (): void => {
        cleanup();
    };

    return { addListener, close };
}

export function createIPCClient(socketPath: string): IPCClient {
    const pidFile = `${socketPath}.pid`;

    const emit = (event: string): Promise<void> => {
        return new Promise((resolve, reject) => {
            const client = net.createConnection(socketPath);

            client.on('connect', () => {
                client.write(event);
                client.end();
                resolve();
            });

            client.on('error', (err: NodeJS.ErrnoException) => {
                if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
                    reject(new Error('IPC server not running'));
                } else {
                    reject(err);
                }
            });

            client.on('close', () => {
                // connection closed, event sent successfully
            });
        });
    };

    const isServerRunning = (): boolean => {
        if (!fs.existsSync(pidFile)) return false;
        if (!fs.existsSync(socketPath)) return false;

        try {
            const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim());
            // check if process is actually running
            process.kill(pid, 0); // throws if process doesn't exist

            // also test socket connectivity
            const testClient = net.createConnection(socketPath);
            testClient.on('connect', () => {
                testClient.end();
            });
            testClient.on('error', () => {
                // socket exists but not connectable, clean up stale files
                try {
                    fs.unlinkSync(pidFile);
                    fs.unlinkSync(socketPath);
                } catch { }
                return false;
            });

            return true;
        } catch (e) {
            // PID file exists but process is dead, clean it up
            try {
                fs.unlinkSync(pidFile);
                if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
            } catch { }
            return false;
        }
    };

    const ensureServerRunning = async (serverScript: string): Promise<void> => {
        if (isServerRunning()) {
            return;
        }

        const child = spawn('node', [serverScript.replace('~', process.env.HOME || '')], {
            detached: true,
            stdio: 'ignore'
        });

        child.unref();
        child.on('error', (err) => {
            throw new Error(`Failed to spawn server: ${err.message}`);
        });

        // Wait for server to create socket and PID file
        let attempts = 0;
        while (attempts < 50 && !isServerRunning()) {
            await new Promise(r => setTimeout(r, 100));
            attempts++;
        }

        if (!isServerRunning()) {
            throw new Error('Server failed to start within timeout period');
        }
    };

    return { emit, ensureServerRunning };
}
