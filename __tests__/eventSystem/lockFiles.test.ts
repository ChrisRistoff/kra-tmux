import * as fs from 'fs/promises';
import {
    LockFiles,
    deleteLockFile,
    oneOfMultipleLocksExist,
    lockFileExist,
    createLockFile
} from '@/../eventSystem/lockFiles';

jest.mock('fs/promises');
jest.mock('@/../src/filePaths', () => ({
    lockFilesPath: '/mock/lock/files'
}));

describe('lockFiles', () => {
    const mockFs = jest.mocked(fs);

    beforeEach(() => {
        jest.clearAllMocks();

        // Default mock implementations
        mockFs.rm.mockResolvedValue();
        mockFs.readFile.mockResolvedValue('');
        mockFs.writeFile.mockResolvedValue();

        // Mock Date.now to return consistent timestamp
        jest.spyOn(Date, 'now').mockReturnValue(1640995200000); // 2022-01-01 00:00:00
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('deleteLockFile', () => {
        it('should delete lock file successfully', async () => {
            await deleteLockFile(LockFiles.LoadInProgress);

            expect(mockFs.rm).toHaveBeenCalledWith('/mock/lock/files/LoadInProgress');
        });

        it('should handle deletion errors gracefully', async () => {
            const error = new Error('File not found');
            mockFs.rm.mockRejectedValue(error);
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

            await deleteLockFile(LockFiles.AutoSaveInProgress);

            expect(consoleSpy).toHaveBeenCalledWith(error);
            consoleSpy.mockRestore();
        });

        it('should delete all types of lock files', async () => {
            await deleteLockFile(LockFiles.LoadInProgress);
            await deleteLockFile(LockFiles.AutoSaveInProgress);
            await deleteLockFile(LockFiles.ServerKillInProgress);

            expect(mockFs.rm).toHaveBeenCalledWith('/mock/lock/files/LoadInProgress');
            expect(mockFs.rm).toHaveBeenCalledWith('/mock/lock/files/AutoSaveInProgress');
            expect(mockFs.rm).toHaveBeenCalledWith('/mock/lock/files/ServerKillInProgress');
        });
    });

    describe('oneOfMultipleLocksExist', () => {
        it('should return true when at least one lock exists', async () => {
            const validLockData = JSON.stringify({ timestamp: Date.now() });
            mockFs.readFile
                .mockResolvedValueOnce(validLockData) // LoadInProgress exists
                .mockRejectedValueOnce(new Error('File not found')); // AutoSaveInProgress doesn't exist

            const result = await oneOfMultipleLocksExist([
                LockFiles.LoadInProgress,
                LockFiles.AutoSaveInProgress
            ]);

            expect(result).toBe(true);
        });

        it('should return false when no locks exist', async () => {
            mockFs.readFile.mockRejectedValue(new Error('File not found'));

            const result = await oneOfMultipleLocksExist([
                LockFiles.LoadInProgress,
                LockFiles.AutoSaveInProgress,
                LockFiles.ServerKillInProgress
            ]);

            expect(result).toBe(false);
        });

        it('should handle empty array', async () => {
            const result = await oneOfMultipleLocksExist([]);

            expect(result).toBe(false);
        });

        it('should return true when multiple locks exist', async () => {
            const validLockData = JSON.stringify({ timestamp: Date.now() });
            mockFs.readFile.mockResolvedValue(validLockData);

            const result = await oneOfMultipleLocksExist([
                LockFiles.LoadInProgress,
                LockFiles.AutoSaveInProgress
            ]);

            expect(result).toBe(true);
        });

        it('should handle mix of stale and valid locks', async () => {
            const currentTime = 1640995200000;
            const staleLockData = JSON.stringify({ timestamp: currentTime - 20000 }); // 20 seconds ago
            const validLockData = JSON.stringify({ timestamp: currentTime });

            mockFs.readFile
                .mockResolvedValueOnce(staleLockData) // LoadInProgress is stale (> 10s old)
                .mockResolvedValueOnce(validLockData); // AutoSaveInProgress is valid

            const result = await oneOfMultipleLocksExist([
                LockFiles.LoadInProgress,
                LockFiles.AutoSaveInProgress
            ]);

            expect(result).toBe(true);
            expect(mockFs.rm).toHaveBeenCalledWith('/mock/lock/files/LoadInProgress');
        });
    });

    describe('lockFileExist', () => {
        it('should return true for valid LoadInProgress lock', async () => {
            const validLockData = JSON.stringify({ timestamp: Date.now() });
            mockFs.readFile.mockResolvedValue(validLockData);

            const result = await lockFileExist(LockFiles.LoadInProgress);

            expect(result).toBe(true);
            expect(mockFs.readFile).toHaveBeenCalledWith('/mock/lock/files/LoadInProgress', 'utf-8');
        });

        it('should return true for valid AutoSaveInProgress lock', async () => {
            const validLockData = JSON.stringify({ timestamp: Date.now() });
            mockFs.readFile.mockResolvedValue(validLockData);

            const result = await lockFileExist(LockFiles.AutoSaveInProgress);

            expect(result).toBe(true);
        });

        it('should return true for valid ServerKillInProgress lock', async () => {
            const validLockData = JSON.stringify({ timestamp: Date.now() });
            mockFs.readFile.mockResolvedValue(validLockData);

            const result = await lockFileExist(LockFiles.ServerKillInProgress);

            expect(result).toBe(true);
        });

        it('should return false when file does not exist', async () => {
            mockFs.readFile.mockRejectedValue(new Error('File not found'));

            const result = await lockFileExist(LockFiles.LoadInProgress);

            expect(result).toBe(false);
        });

        it('should return false and cleanup stale LoadInProgress lock', async () => {
            const currentTime = 1640995200000;
            const staleLockData = JSON.stringify({
                timestamp: currentTime - 15000 // 15 seconds ago (> 10s timeout)
            });

            mockFs.readFile.mockResolvedValue(staleLockData);
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

            const result = await lockFileExist(LockFiles.LoadInProgress);

            expect(result).toBe(false);
            expect(consoleSpy).toHaveBeenCalledWith('Removing stale LoadInProgress lock file');
            expect(mockFs.rm).toHaveBeenCalledWith('/mock/lock/files/LoadInProgress');

            consoleSpy.mockRestore();
        });

        it('should return false and cleanup stale AutoSaveInProgress lock', async () => {
            const currentTime = 1640995200000;
            const staleLockData = JSON.stringify({
                timestamp: currentTime - (6 * 60 * 1000) // 6 minutes ago (> 5min timeout)
            });

            mockFs.readFile.mockResolvedValue(staleLockData);
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

            const result = await lockFileExist(LockFiles.AutoSaveInProgress);

            expect(result).toBe(false);
            expect(consoleSpy).toHaveBeenCalledWith('Removing stale AutoSaveInProgress lock file');
            expect(mockFs.rm).toHaveBeenCalledWith('/mock/lock/files/AutoSaveInProgress');

            consoleSpy.mockRestore();
        });

        it('should return false and cleanup stale ServerKillInProgress lock', async () => {
            const currentTime = 1640995200000;
            const staleLockData = JSON.stringify({
                timestamp: currentTime - 7000 // 7 seconds ago (> 5s timeout)
            });

            mockFs.readFile.mockResolvedValue(staleLockData);
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

            const result = await lockFileExist(LockFiles.ServerKillInProgress);

            expect(result).toBe(false);
            expect(consoleSpy).toHaveBeenCalledWith('Removing stale ServerKillInProgress lock file');
            expect(mockFs.rm).toHaveBeenCalledWith('/mock/lock/files/ServerKillInProgress');

            consoleSpy.mockRestore();
        });

        it('should handle invalid JSON in lock file', async () => {
            mockFs.readFile.mockResolvedValue('invalid json');

            const result = await lockFileExist(LockFiles.LoadInProgress);

            expect(result).toBe(false);
        });

        it('should handle file read error during cleanup', async () => {
            const currentTime = 1640995200000;
            const staleLockData = JSON.stringify({
                timestamp: currentTime - 15000 // Stale lock
            });

            mockFs.readFile.mockResolvedValue(staleLockData);
            mockFs.rm.mockRejectedValue(new Error('Cannot delete'));
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

            const result = await lockFileExist(LockFiles.LoadInProgress);

            expect(result).toBe(false);
            expect(consoleSpy).toHaveBeenCalledWith('Removing stale LoadInProgress lock file');
            expect(consoleSpy).toHaveBeenCalledWith(expect.any(Error));

            consoleSpy.mockRestore();
        });
    });

    describe('createLockFile', () => {
        it('should create LoadInProgress lock file', async () => {
            await createLockFile(LockFiles.LoadInProgress);

            expect(mockFs.writeFile).toHaveBeenCalledWith(
                '/mock/lock/files/LoadInProgress',
                JSON.stringify({ timestamp: 1640995200000 })
            );
        });

        it('should create AutoSaveInProgress lock file', async () => {
            await createLockFile(LockFiles.AutoSaveInProgress);

            expect(mockFs.writeFile).toHaveBeenCalledWith(
                '/mock/lock/files/AutoSaveInProgress',
                JSON.stringify({ timestamp: 1640995200000 })
            );
        });

        it('should create ServerKillInProgress lock file', async () => {
            await createLockFile(LockFiles.ServerKillInProgress);

            expect(mockFs.writeFile).toHaveBeenCalledWith(
                '/mock/lock/files/ServerKillInProgress',
                JSON.stringify({ timestamp: 1640995200000 })
            );
        });

        it('should handle write errors', async () => {
            mockFs.writeFile.mockRejectedValue(new Error('Write failed'));

            await expect(createLockFile(LockFiles.LoadInProgress)).rejects.toThrow('Write failed');
        });

        it('should create lock files with current timestamp', async () => {
            const mockTimestamp = 1641000000000;
            jest.spyOn(Date, 'now').mockReturnValue(mockTimestamp);

            await createLockFile(LockFiles.LoadInProgress);

            expect(mockFs.writeFile).toHaveBeenCalledWith(
                '/mock/lock/files/LoadInProgress',
                JSON.stringify({ timestamp: mockTimestamp })
            );
        });
    });
});
