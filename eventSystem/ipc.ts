import net from 'net';
import fs from 'fs';
import * as bash from '../src/utils/bashHelper';

export interface IPCServer {
    addListener: (handler: (event: string) => void) => Promise<void>;
    close: () => void;
}

export interface IPCClient {
    emit: (event: string) => Promise<void>;
    ensureServerRunning: (serverScript: string) => Promise<void>;
    ensureConnected: () => Promise<void>;
}

export function createIPCServer(socketPath: string): IPCServer {
    let server: net.Server | null = null;

    const cleanup = () => {
        if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
    };

    const addListener = (handler: (event: string) => void): Promise<void> => {
        return new Promise((resolve) => {
            cleanup();

            server = net.createServer(socket => {
                socket.on('data', data => {
                    const event = data.toString().trim();
                    handler(event);
                });
                socket.on('error', () => { });
            });

            server.listen(socketPath, () => {
                console.log(`IPC server listening: ${socketPath}`);
                resolve();
            });

            process.on('exit', cleanup);
            process.on('SIGINT', () => process.exit(0));
        });
    }

    const close = (): void => {
        if (server) {
            server.close();
            server = null;
        }

        cleanup();
    }

    return { addListener, close }
}

export function createIPCClient(socketPath: string): IPCClient {
    const emit = (event: string): Promise<void> => {
        return new Promise(resolve => {
            const client = net.connect(socketPath, () => client.write(event));
            client.on('data', () => { client.end(); resolve(); });
            client.on('error', () => resolve()); // Silent fail
            setTimeout(() => { client.destroy(); resolve(); }, 50);
        });
    };

    const ensureServerRunning = async (serverScript: string): Promise<void> => {
        if (!fs.existsSync(socketPath)) {
            console.log(`Starting server: ${serverScript}`);
            bash.runCommand('node', [serverScript.replace('~', process.env.HOME || '')], {
                detached: true,
                stdio: 'ignore'
            });

            await new Promise(r => setTimeout(r, 200));
        }
    };

    const ensureConnected = async () => {
        let tries = 0;

        while (!fs.existsSync(socketPath) && tries < 50) {
            tries++
            await new Promise(r => setTimeout(r, 50));
        }

        if (tries === 50) {
            console.log('Socket file not found.');
        }
    };

    return { emit, ensureServerRunning, ensureConnected };
}
