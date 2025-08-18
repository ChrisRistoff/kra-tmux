import fs from 'fs';
import path from 'path';
import * as bash from '../src/utils/bashHelper';

export interface IPCServer {
    addListener: (handler: (event: string) => void) => Promise<void>;
    close: () => void;
}

export interface IPCClient {
    emit: (event: string) => Promise<void>;
    ensureServerRunning: (serverScript: string) => Promise<void>;
}

export function createIPCServer(socketPath: string): IPCServer {
    let polling = false;

    // generate paths based on the socket path
    const signalDir = `${socketPath}-signals`;
    const pidFile = `${socketPath}.pid`;

    const ensureSignalDir = () => {
        if (!fs.existsSync(signalDir)) {
            fs.mkdirSync(signalDir, { recursive: true });
        }
    };

    const addListener = (handler: (event: string) => void): Promise<void> => {
        return new Promise((resolve) => {
            ensureSignalDir();

            // write pid file so client knows we're running
            fs.writeFileSync(pidFile, process.pid.toString());

            polling = true;
            const pollForEvents = () => {
                if (!polling) return;

                try {
                    const files = fs.readdirSync(signalDir);
                    for (const file of files) {
                        if (file.startsWith('event-')) {
                            const eventPath = path.join(signalDir, file);
                            const event = fs.readFileSync(eventPath, 'utf8').trim();

                            handler(event);

                            // remove the processed event file
                            fs.unlinkSync(eventPath);
                        }
                    }
                } catch (err) {
                    // ignore errors, keep polling
                }

                setTimeout(pollForEvents, 100);
            };

            pollForEvents();

            // Cleanup on exit
            const cleanup = () => {
                polling = false;
                try {
                    if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
                    if (fs.existsSync(signalDir)) {
                        const files = fs.readdirSync(signalDir);
                        files.forEach(file => {
                            fs.unlinkSync(path.join(signalDir, file));
                        });
                        fs.rmdirSync(signalDir);
                    }
                } catch (e) {
                    // ignore cleanup errors
                }
            };

            process.on('exit', cleanup);
            process.on('SIGINT', () => { cleanup(); process.exit(0); });
            process.on('SIGTERM', () => { cleanup(); process.exit(0); });

            resolve();
        });
    };

    const close = (): void => {
        polling = false;
        if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
    };

    return { addListener, close };
}

export function createIPCClient(socketPath: string): IPCClient {
    // generate paths based on the socket path
    const signalDir = `${socketPath}-signals`;
    const pidFile = `${socketPath}.pid`;

    const ensureSignalDir = () => {
        if (!fs.existsSync(signalDir)) {
            fs.mkdirSync(signalDir, { recursive: true });
        }
    };

    const emit = (event: string): Promise<void> => {
        return new Promise((resolve, reject) => {
            try {
                ensureSignalDir();
                const eventFile = path.join(signalDir, `event-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
                fs.writeFileSync(eventFile, event);
                resolve();
            } catch (err) {
                reject(err);
            }
        });
    };

    const isServerRunning = (): boolean => {
        if (!fs.existsSync(pidFile)) return false;

        try {
            const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim());
            // check if process is actually running
            process.kill(pid, 0); // throws if process doesn't exist
            return true;
        } catch (e) {
            // PID file exists but process is dead, clean it up
            try { fs.unlinkSync(pidFile); } catch { }
            return false;
        }
    };

    const ensureServerRunning = async (serverScript: string): Promise<void> => {
        if (isServerRunning()) {
            return;
        }

        bash.runCommand('node', [serverScript.replace('~', process.env.HOME || '')], {
            detached: true,
            stdio: 'ignore'
        });

        // wait for server to write PID file
        let attempts = 0;
        while (attempts < 50 && !isServerRunning()) {
            await new Promise(r => setTimeout(r, 100));
            attempts++;
        }

        if (!isServerRunning()) {
            throw new Error('Server failed to start');
        }
    };

    return { emit, ensureServerRunning };
}
