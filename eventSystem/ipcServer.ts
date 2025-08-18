import fs from 'fs';
import path from 'path';

export interface IPCServer {
    addListener: (handler: (event: string) => void) => Promise<void>;
    close: () => void;
}

export function createIPCServer(socketPath: string): IPCServer {
    const signalDir = `${socketPath}-signals`;
    const pidFile = `${socketPath}.pid`;

    let polling = false;

    const ensureSignalDir = () => {
        if (!fs.existsSync(signalDir)) {
            fs.mkdirSync(signalDir, { recursive: true });
        }
    }

    const purgeStaleEvents = () => {
        try {
            const files = fs.readdirSync(signalDir);

            for (let i = 0; i < files.length; i++) {
                if (files[i].startsWith('event-')) {
                    fs.unlinkSync(path.join(signalDir, files[i]));
                }
            }
        } catch {}
    }

    ensureSignalDir();
    fs.writeFileSync(pidFile, process.pid.toString(), 'utf8');
    purgeStaleEvents();

    const addListener = (handler: (event: string) => void): Promise<void> => {
        return new Promise((resolve) => {
            polling = true;

            const pollForEvents = () => {
                if (!polling) {
                    return;
                }

                try {
                    const files = fs.readdirSync(signalDir);

                    for (const file of files) {
                        if (file.startsWith('event-')) {
                            const eventPath = path.join(signalDir, file);
                            const event = fs.readFileSync(eventPath, 'utf8').trim();

                            try {
                                handler(event);
                            } catch (error) {
                                console.log('Handler error: ', error);
                            }

                            try { fs.unlinkSync(eventPath) } catch {}
                        }
                    }
                } catch {}

                setTimeout(pollForEvents, 50);
            }

            pollForEvents();

            const cleanup = () => {
                polling = false;

                try { if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile)} catch {}
            }

            process.on('exit', cleanup);
            process.on('SIGINT', () => { cleanup(); process.exit(0); })
            process.on('SIGTERM', () => { cleanup(); process.exit(0); })

            resolve();
        })
    }

    const close = () => {
        polling = false;

        try { if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile) } catch {}
    }

    return { addListener, close }
}
