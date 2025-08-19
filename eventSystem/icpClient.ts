import fs from 'fs';
import path from "path";
import { spawn } from 'child_process';

export interface IPCClient {
    emit: (event: string) => Promise<void>;
    ensureServerRunning: (serverScript: string) => Promise<void>;
}

export function createIPCClient(socketPath: string): IPCClient {
    const signalDir = `${socketPath}-signals`;
    const pidFile = `${socketPath}.pid`;

    const ensureSignalDir = () => {
        if (!fs.existsSync(signalDir)) {
            fs.mkdirSync(signalDir, { recursive: true });
        }
    }

    const emit = async (event: string): Promise<void> => {
        ensureSignalDir();

        const tmpFile = path.join(
            signalDir,
            `event-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
        );

        const finalFile = tmpFile.replace(/\.tmp$/, '');

        fs.writeFileSync(tmpFile, event, 'utf8');
        fs.renameSync(tmpFile, finalFile);
    }

    const isServerRunning = (): boolean => {
        if (!fs.existsSync(pidFile)) {
            return false;
        }

        try {
            const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
            process.kill(pid, 0);

            return true;
        } catch {
            try { fs.unlinkSync(pidFile) } catch {}

            return false;
        }
    }

    const ensureServerRunning = async (serverScript: string): Promise<void> => {
        if (isServerRunning()) return;

        spawn('node', [serverScript.replace('~', process.env.HOME || '')], {
            detached: true,
            stdio: 'ignore',
        })

        let attempts = 0;

        while (attempts < 50 && !isServerRunning()) {
            await new Promise(r => setTimeout(r, 50));
            attempts++;
        }

        if (!isServerRunning()) {
            const serverFileArray = serverScript.split('/');
            throw new Error(`Server for ${serverFileArray[serverFileArray.length - 1]} failed to start`);
        }
    }

    return { emit, ensureServerRunning };
}
