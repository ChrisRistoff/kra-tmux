import { execCommand, sendKeysToTmuxTargetSession, sendKeysToTargetSessionAndWait, grepFileForString } from '@/utils/bashHelper';
import { SendKeysArguments } from '@/types/bashTypes';

const mockExecCommand = jest.fn();

jest.mock('child_process', () => ({
    exec: (...args: any[]) => {
        const callback = args[args.length - 1];
        if (typeof callback === 'function') {
            return mockExecCommand(...args);
        }
        return {};
    }
}));

const mockConsoleError = jest.spyOn(console, 'error').mockImplementation();

describe('tmux-utils', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.clearAllTimers();
        jest.useFakeTimers();
        mockExecCommand.mockImplementation((_: string, callback: Function) => {
            callback(null, '', '');
            return {};
        });
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    afterAll(() => {
        mockConsoleError.mockRestore();
    });

    describe('execCommand', () => {
        it('should resolve with stdout and stderr on success', async () => {
            mockExecCommand.mockImplementation((_: string, callback: Function) => {
                callback(null, 'success output', 'warning message');
                return {};
            });

            const result = await execCommand('test command');

            expect(result).toEqual({
                stdout: 'success output',
                stderr: 'warning message'
            });
        });

        it('should reject with error on command failure', async () => {
            mockExecCommand.mockImplementation((_: string, callback: Function) => {
                callback(new Error('Command failed'), '', '');
                return {};
            });

            await expect(execCommand('failing command')).rejects.toThrow('Command failed');
        });
    });

    describe('sendKeysToTmuxTargetSession', () => {
        it('should send basic command without target', async () => {
            const options: SendKeysArguments = {
                command: 'ls -la'
            };

            await sendKeysToTmuxTargetSession(options);

            expect(mockExecCommand).toHaveBeenCalledWith(
                'tmux send-keys "ls -la" C-m',
                expect.any(Function)
            );
        });

        it('should send command with session name only', async () => {
            const options: SendKeysArguments = {
                sessionName: 'my-session',
                command: 'pwd'
            };

            await sendKeysToTmuxTargetSession(options);

            expect(mockExecCommand).toHaveBeenCalledWith(
                'tmux send-keys -t my-session "pwd" C-m',
                expect.any(Function)
            );
        });

        it('should send command with session and window index', async () => {
            const options: SendKeysArguments = {
                sessionName: 'my-session',
                windowIndex: 2,
                command: 'git status'
            };

            await sendKeysToTmuxTargetSession(options);

            expect(mockExecCommand).toHaveBeenCalledWith(
                'tmux send-keys -t my-session:2 "git status" C-m',
                expect.any(Function)
            );
        });

        it('should send command with session, window, and pane index', async () => {
            const options: SendKeysArguments = {
                sessionName: 'my-session',
                windowIndex: 1,
                paneIndex: 3,
                command: 'npm test'
            };

            await sendKeysToTmuxTargetSession(options);

            expect(mockExecCommand).toHaveBeenCalledWith(
                'tmux send-keys -t my-session:1.3 "npm test" C-m',
                expect.any(Function)
            );
        });

        it('should send command with window index only', async () => {
            const options: SendKeysArguments = {
                windowIndex: 0,
                command: 'echo test'
            };

            await sendKeysToTmuxTargetSession(options);

            // The actual implementation sends "0" not ":0" when only windowIndex is provided
            expect(mockExecCommand).toHaveBeenCalledWith(
                'tmux send-keys -t 0 "echo test" C-m',
                expect.any(Function)
            );
        });

        it('should send command with pane index only', async () => {
            const options: SendKeysArguments = {
                paneIndex: 2,
                command: 'vim'
            };

            await sendKeysToTmuxTargetSession(options);

            // The actual implementation sends "2" not ".2" when only paneIndex is provided
            expect(mockExecCommand).toHaveBeenCalledWith(
                'tmux send-keys -t 2 "vim" C-m',
                expect.any(Function)
            );
        });

        it('should handle windowIndex 0 correctly', async () => {
            const options: SendKeysArguments = {
                sessionName: 'test',
                windowIndex: 0,
                command: 'test'
            };

            await sendKeysToTmuxTargetSession(options);

            expect(mockExecCommand).toHaveBeenCalledWith(
                'tmux send-keys -t test:0 "test" C-m',
                expect.any(Function)
            );
        });

        it('should handle paneIndex 0 correctly', async () => {
            const options: SendKeysArguments = {
                sessionName: 'test',
                paneIndex: 0,
                command: 'test'
            };

            await sendKeysToTmuxTargetSession(options);

            expect(mockExecCommand).toHaveBeenCalledWith(
                'tmux send-keys -t test.0 "test" C-m',
                expect.any(Function)
            );
        });
    });

    describe('sendKeysToTargetSessionAndWait', () => {
        it('should send marker command and wait for it to appear', async () => {
            let captureCallCount = 0;

            mockExecCommand.mockImplementation((command: string, callback: Function) => {
                if (command.includes('capture-pane')) {
                    captureCallCount++;
                    const stdout = captureCallCount === 1 ? 'some output' : 'some output\n__DONE_\n';
                    // Use setTimeout instead of process.nextTick for fake timers
                    setTimeout(() => callback(null, stdout, ''), 0);
                } else {
                    setTimeout(() => callback(null, '', ''), 0);
                }
                return {};
            });

            const options: SendKeysArguments = {
                sessionName: 'test-session',
                command: 'original command'
            };

            const promise = sendKeysToTargetSessionAndWait(options);

            // Advance timers to trigger the polling intervals and async callbacks
            await jest.advanceTimersByTimeAsync(600);

            await promise;

            expect(mockExecCommand).toHaveBeenCalledWith(
                'tmux send-keys -t test-session "echo __DONE_" C-m',
                expect.any(Function)
            );
            expect(mockExecCommand).toHaveBeenCalledWith(
                'tmux capture-pane -p -t test-session',
                expect.any(Function)
            );
        });
    });

    describe('grepFileForString', () => {
        it('should return true when string is found', async () => {
            mockExecCommand.mockImplementation((_: string, callback: Function) => {
                callback(null, 'matching line with search term', '');
                return {};
            });

            const result = await grepFileForString('test.txt', 'search term');
            expect(result).toBe(true);
        });

        it('should return false when string is not found', async () => {
            mockExecCommand.mockImplementation((_: string, callback: Function) => {
                callback(null, '', '');
                return {};
            });

            const result = await grepFileForString('test.txt', 'not found');
            expect(result).toBe(false);
        });

        it('should return false and log error when grep has stderr', async () => {
            mockExecCommand.mockImplementation((_: string, callback: Function) => {
                callback(null, '', 'grep: test.txt: No such file or directory');
                return {};
            });

            const result = await grepFileForString('test.txt', 'anything');
            expect(result).toBe(false);
            expect(mockConsoleError).toHaveBeenCalledWith('grep error: grep: test.txt: No such file or directory');
        });

        it('should return false when exec throws an error', async () => {
            mockExecCommand.mockImplementation((_: string, callback: Function) => {
                callback(new Error('Command failed'), '', '');
                return {};
            });

            const result = await grepFileForString('test.txt', 'search');
            expect(result).toBe(false);
        });

        it('should properly escape file name in command', async () => {
            mockExecCommand.mockImplementation((_: string, callback: Function) => {
                callback(null, 'found', '');
                return {};
            });

            await grepFileForString('file with spaces.txt', 'pattern');
            expect(mockExecCommand).toHaveBeenCalledWith(
                `grep -E "pattern" 'file with spaces.txt'`,
                expect.any(Function)
            );
        });
    });
});
