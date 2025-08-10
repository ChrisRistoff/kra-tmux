import fs from 'fs';
import net from 'net';
import { spawn } from 'child_process';
import { createIPCServer, createIPCClient, IPCServer, IPCClient } from '../../eventSystem/ipc';

jest.mock('fs');
jest.mock('net');
jest.mock('child_process');

describe('IPC', () => {
    const mockFs = jest.mocked(fs);
    const mockNet = jest.mocked(net);
    const mockSpawn = jest.mocked(spawn);

    const mockSocketPath = '/tmp/test-socket';
    const mockPidFile = '/tmp/test-socket.pid';

    let mockServer: any;
    let mockSocket: any;
    let mockClient: any;

    beforeEach(() => {
        jest.clearAllMocks();

        // mock the server socket
        mockSocket = {
            on: jest.fn(),
            write: jest.fn(),
            end: jest.fn(),
        };

        mockServer = {
            listen: jest.fn((_: string, callback: () => void) => {
                setTimeout(callback, 0); // simulate async listen
            }),
            on: jest.fn(),
            close: jest.fn(),
        };

        mockClient = {
            on: jest.fn(),
            write: jest.fn(),
            end: jest.fn(),
        };

        mockNet.createServer.mockImplementation((callback: any) => {
            // store the connection callback for later use
            (mockServer as any).connectionCallback = callback;
            return mockServer;
        });

        mockNet.createConnection.mockReturnValue(mockClient);

        mockFs.existsSync.mockReturnValue(false);
        mockFs.writeFileSync.mockImplementation(() => { });
        mockFs.readFileSync.mockReturnValue('12345');
        mockFs.unlinkSync.mockImplementation(() => { });
        mockFs.chmodSync.mockImplementation(() => { });

        const mockChildProcess = {
            on: jest.fn(),
            unref: jest.fn(),
            pid: 99999
        };
        mockSpawn.mockReturnValue(mockChildProcess as any);

        Object.defineProperty(process, 'pid', { value: 12345, configurable: true });
        process.env.HOME = '/home/user';
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('createIPCServer', () => {
        let server: IPCServer;

        beforeEach(() => {
            server = createIPCServer(mockSocketPath);
        });

        it('should create server and listen on socket path', async () => {
            const handler = jest.fn();

            await server.addListener(handler);

            expect(mockNet.createServer).toHaveBeenCalled();
            expect(mockServer.listen).toHaveBeenCalledWith(mockSocketPath, expect.any(Function));
            expect(mockFs.writeFileSync).toHaveBeenCalledWith(mockPidFile, '12345');
            expect(mockFs.chmodSync).toHaveBeenCalledWith(mockSocketPath, 0o600);
        });

        it('should clean up existing socket before listening', async () => {
            mockFs.existsSync.mockReturnValue(true);
            const handler = jest.fn();

            await server.addListener(handler);

            expect(mockFs.unlinkSync).toHaveBeenCalledWith(mockSocketPath);
        });

        it('should handle EADDRINUSE error by retrying', async () => {
            const handler = jest.fn();
            let errorCalled = false;

            mockServer.on.mockImplementation((event: string, callback: (err: NodeJS.ErrnoException) => void) => {
                if (event === 'error' && !errorCalled) {
                    errorCalled = true;
                    setTimeout(() => {
                        const error = new Error('Address already in use') as NodeJS.ErrnoException;
                        error.code = 'EADDRINUSE';
                        callback(error);
                    }, 0);
                }
            });

            // second attempt should work
            mockServer.listen.mockImplementationOnce(() => { }).mockImplementationOnce((_: string, callback: () => void) => {
                setTimeout(callback, 0);
            });

            await server.addListener(handler);

            expect(mockServer.listen).toHaveBeenCalledTimes(2);
        });

        it('should process incoming socket data', async () => {
            const handler = jest.fn();

            await server.addListener(handler);

            // simulate client connection
            const connectionCallback = (mockServer as any).connectionCallback;
            connectionCallback(mockSocket);

            // simulate data received
            const dataCallback = mockSocket.on.mock.calls.find(([event]: [string]) => event === 'data')[1];
            dataCallback(Buffer.from('test-event-data'));

            expect(handler).toHaveBeenCalledWith('test-event-data');
        });

        it('should handle empty or whitespace-only messages', async () => {
            const handler = jest.fn();

            await server.addListener(handler);

            const connectionCallback = (mockServer as any).connectionCallback;
            connectionCallback(mockSocket);

            const dataCallback = mockSocket.on.mock.calls.find(([event]: [string]) => event === 'data')[1];

            // send empty and whitespace messages
            dataCallback(Buffer.from('   '));
            dataCallback(Buffer.from(''));
            dataCallback(Buffer.from('\n\t  \n'));

            expect(handler).not.toHaveBeenCalled();
        });

        it('should handle socket client errors', async () => {
            const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => { });
            const handler = jest.fn();

            await server.addListener(handler);

            const connectionCallback = (mockServer as any).connectionCallback;
            connectionCallback(mockSocket);

            // simulate socket error
            const errorCallback = mockSocket.on.mock.calls.find(([event]: [string]) => event === 'error')[1];
            errorCallback(new Error('Socket error'));

            expect(consoleSpy).toHaveBeenCalledWith('Socket client error:', expect.any(Error));
            consoleSpy.mockRestore();
        });

        it('should cleanup on close', async () => {
            mockFs.existsSync.mockReturnValue(true);

            // need to setup the server first
            await server.addListener(() => { });

            server.close();

            expect(mockServer.close).toHaveBeenCalled();
            expect(mockFs.unlinkSync).toHaveBeenCalledWith(mockSocketPath);
            expect(mockFs.unlinkSync).toHaveBeenCalledWith(mockPidFile);
        });

        it('should ignore cleanup errors', () => {
            mockFs.unlinkSync.mockImplementation(() => {
                throw new Error('Cleanup failed');
            });

            // should not throw
            expect(() => server.close()).not.toThrow();
        });

        it('should setup process exit handlers', async () => {
            const processOnSpy = jest.spyOn(process, 'on').mockImplementation(() => process);
            const handler = jest.fn();

            await server.addListener(handler);

            expect(processOnSpy).toHaveBeenCalledWith('exit', expect.any(Function));
            expect(processOnSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
            expect(processOnSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));

            processOnSpy.mockRestore();
        });
    });

    describe('createIPCClient', () => {
        let client: IPCClient;

        beforeEach(() => {
            client = createIPCClient(mockSocketPath);
        });

        it('should emit event through socket connection', async () => {
            // simulate successful connection
            mockClient.on.mockImplementation((event: string, callback: () => void) => {
                if (event === 'connect') {
                    setTimeout(callback, 0);
                }
            });

            await client.emit('test-event');

            expect(mockNet.createConnection).toHaveBeenCalledWith(mockSocketPath);
            expect(mockClient.write).toHaveBeenCalledWith('test-event');
            expect(mockClient.end).toHaveBeenCalled();
        });

        it('should handle connection errors', async () => {
            mockClient.on.mockImplementation((event: string, callback: (err: NodeJS.ErrnoException) => void) => {
                if (event === 'error') {
                    setTimeout(() => {
                        const error = new Error('Connection refused') as NodeJS.ErrnoException;
                        error.code = 'ECONNREFUSED';
                        callback(error);
                    }, 0);
                }
            });

            await expect(client.emit('test-event')).rejects.toThrow('IPC server not running');
        });

        it('should handle ENOENT errors', async () => {
            mockClient.on.mockImplementation((event: string, callback: (err: NodeJS.ErrnoException) => void) => {
                if (event === 'error') {
                    setTimeout(() => {
                        const error = new Error('No such file') as NodeJS.ErrnoException;
                        error.code = 'ENOENT';
                        callback(error);
                    }, 0);
                }
            });

            await expect(client.emit('test-event')).rejects.toThrow('IPC server not running');
        });

        it('should check if server is running with valid PID and socket', async () => {
            mockFs.existsSync.mockReturnValue(true);
            mockFs.readFileSync.mockReturnValue('54321');

            const processSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);

            // mock successful test connection
            mockClient.on.mockImplementation((event: string, callback: () => void) => {
                if (event === 'connect') {
                    setTimeout(callback, 0);
                }
            });

            await client.ensureServerRunning('/path/to/server.js');

            expect(mockFs.readFileSync).toHaveBeenCalledWith(mockPidFile, 'utf8');
            expect(processSpy).toHaveBeenCalledWith(54321, 0);
            expect(mockSpawn).not.toHaveBeenCalled();

            processSpy.mockRestore();
        });

        it('should start server when PID file missing', async () => {
            mockFs.existsSync.mockReturnValue(false);

            // simulate server startup
            setTimeout(() => {
                mockFs.existsSync.mockReturnValue(true);
                mockFs.readFileSync.mockReturnValue('99999');
                jest.spyOn(process, 'kill').mockImplementation(() => true);

                mockClient.on.mockImplementation((event: string, callback: () => void) => {
                    if (event === 'connect') {
                        setTimeout(callback, 0);
                    }
                });
            }, 50);

            const ensurePromise = client.ensureServerRunning('/path/to/server.js');
            jest.advanceTimersByTime(100);

            await ensurePromise;

            expect(mockSpawn).toHaveBeenCalledWith('node', ['/path/to/server.js'], {
                detached: true,
                stdio: 'ignore'
            });
        });

        it('should clean up stale files when socket test fails', async () => {
            // first call - pid file exists but process is dead
            mockFs.existsSync.mockReturnValueOnce(true).mockReturnValueOnce(true);
            mockFs.readFileSync.mockReturnValue('12345');

            // process.kill should throw (process is dead)
            const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {
                throw new Error('No such process');
            });

            // mock the server startup after spawn
            setTimeout(() => {
                mockFs.existsSync.mockReturnValue(true);
                mockFs.readFileSync.mockReturnValue('99999');
                killSpy.mockImplementation(() => true);

                mockClient.on.mockImplementation((event: string, callback: () => void) => {
                    if (event === 'connect') {
                        setTimeout(callback, 0);
                    }
                });
            }, 50);

            await client.ensureServerRunning('/path/to/server.js');

            expect(mockSpawn).toHaveBeenCalled();
            killSpy.mockRestore();
        });

        it('should handle home directory replacement', async () => {
            mockFs.existsSync.mockReturnValue(false);

            setTimeout(() => {
                mockFs.existsSync.mockReturnValue(true);
                mockFs.readFileSync.mockReturnValue('99999');
                jest.spyOn(process, 'kill').mockImplementation(() => true);

                mockClient.on.mockImplementation((event: string, callback: () => void) => {
                    if (event === 'connect') {
                        setTimeout(callback, 0);
                    }
                });
            }, 50);

            const ensurePromise = client.ensureServerRunning('~/scripts/server.js');
            jest.advanceTimersByTime(100);

            await ensurePromise;

            expect(mockSpawn).toHaveBeenCalledWith('node', ['/home/user/scripts/server.js'], {
                detached: true,
                stdio: 'ignore'
            });
        });

        it('should timeout when server fails to start', async () => {
            mockFs.existsSync.mockReturnValue(false);

            const mockChildProcess = {
                on: jest.fn(),
                unref: jest.fn(),
            };
            mockSpawn.mockReturnValue(mockChildProcess as any);

            // server never actually starts (no mocked successful startup)
            // so it should timeout

            await expect(client.ensureServerRunning('/path/to/server.js'))
                .rejects.toThrow('Server failed to start within timeout period');
        }, 10000);

        it('should handle cleanup errors silently during stale file removal', async () => {
            mockFs.existsSync.mockReturnValue(true);
            mockFs.readFileSync.mockReturnValue('12345');
            jest.spyOn(process, 'kill').mockImplementation(() => {
                throw new Error('No such process');
            });

            mockFs.unlinkSync.mockImplementation(() => {
                throw new Error('Cleanup failed');
            });

            // simulate successful startup after cleanup
            setTimeout(() => {
                mockFs.existsSync.mockReturnValue(true);
                mockFs.readFileSync.mockReturnValue('99999');
                jest.spyOn(process, 'kill').mockImplementation(() => true);

                mockClient.on.mockImplementation((event: string, callback: () => void) => {
                    if (event === 'connect') {
                        setTimeout(callback, 0);
                    }
                });
            }, 50);

            const ensurePromise = client.ensureServerRunning('/path/to/server.js');

            // should not throw despite cleanup error
            await expect(ensurePromise).resolves.not.toThrow();
        });
    });
});
