import fs from 'fs';
import * as bash from '../../src/utils/bashHelper';
import * as ui from '../../src/UI/generalUI';
import { saveUntracked, loadUntracked } from '../../src/git/commands/gitUntracked';
import { getCurrentBranch } from '../../src/git/core/gitBranch';
import path from 'path';
import { gitFilesFolder } from '@/filePaths';
import { UNTRACKED_CONFIG } from '@/git/config/gitConstants';

jest.mock('fs');
jest.mock('path');
jest.mock('../../src/utils/bashHelper');
jest.mock('../../src/UI/generalUI');
jest.mock('../../src/git/core/gitBranch');

describe('Git Untracked Operations', () => {
    const mockFs = jest.mocked(fs);
    const mockExecCommand = jest.mocked(bash.execCommand);
    const mockSearchSelect = jest.mocked(ui.searchSelectAndReturnFromArray);
    const mockGetCurrentBranch = jest.mocked(getCurrentBranch);

    beforeEach(() => {
        jest.clearAllMocks();
        mockGetCurrentBranch.mockResolvedValue('main');
    });

    describe('saveUntracked', () => {
        it('should save single untracked file', async () => {
            const file = 'test.txt';
            mockExecCommand
                .mockResolvedValueOnce({ stdout: file + '\n', stderr: '' })
                .mockResolvedValueOnce({ stdout: '/project', stderr: '' });
            mockSearchSelect.mockResolvedValue(file);
            mockFs.existsSync.mockReturnValue(false);
            mockFs.mkdirSync.mockImplementation(() => undefined);
            mockFs.writeFileSync.mockImplementation(() => undefined);

            await saveUntracked();

            expect(mockFs.mkdirSync).toHaveBeenCalled();
            expect(mockExecCommand).toHaveBeenCalledWith(expect.stringContaining('mv'));
            expect(mockFs.writeFileSync).toHaveBeenCalled();
        });

        it('should save all untracked files', async () => {
            const files = ['test1.txt', 'test2.txt'];
            const topLevel = '/project';

            // Mock the file operations
            mockFs.existsSync.mockReturnValue(false);
            mockFs.mkdirSync.mockImplementation(() => undefined);
            mockFs.writeFileSync.mockImplementation(() => undefined);

            // Mock the commands
            mockExecCommand
                .mockResolvedValueOnce({ stdout: files.join('\n'), stderr: '' }) // getUntrackedFiles
                .mockResolvedValueOnce({ stdout: topLevel, stderr: '' }); // getTopLevelPath

            mockSearchSelect.mockResolvedValue('all');

            await saveUntracked();

            // Verify mv commands for each file
            files.forEach(file => {
                expect(mockExecCommand).toHaveBeenCalledWith(
                    expect.stringContaining(`mv ${path.join(topLevel, file)}`)
                );
            });
        });
    });

    describe('loadUntracked', () => {
        it('should load single untracked file', async () => {
            const file = 'test.txt';
            mockFs.readdirSync.mockReturnValue([
                { name: file, isFile: () => true },
                { name: 'pathInfo', isFile: () => true }
            ] as unknown as fs.Dirent[]);
            mockSearchSelect.mockResolvedValue(file);
            mockFs.readFileSync.mockReturnValue(JSON.stringify({
                [file]: '/project/test.txt'
            }));

            await loadUntracked();

            expect(mockExecCommand).toHaveBeenCalledWith(expect.stringContaining('mv'));
        });

        it('should load all untracked files', async () => {
            const files = ['test1.txt', 'test2.txt'];
            const pathInfoObject = {
                'test1.txt': '/project/path/to/test1.txt',
                'test2.txt': '/project/path/to/test2.txt'
            };
            const branchName = 'main';

            // Mock branch name
            mockGetCurrentBranch.mockResolvedValue(branchName);

            // Mock directory reading
            mockFs.readdirSync.mockReturnValue([
                { name: 'test1.txt', isFile: () => true },
                { name: 'test2.txt', isFile: () => true },
                { name: 'pathInfo', isFile: () => true }
            ] as unknown as fs.Dirent[]);

            // Mock path info file reading
            mockFs.readFileSync.mockReturnValue(Buffer.from(JSON.stringify(pathInfoObject)));

            // Mock user selection
            mockSearchSelect.mockResolvedValue('all');

            await loadUntracked();

            // Verify mv commands
            expect(mockExecCommand).toHaveBeenCalledTimes(2);
            files.forEach(file => {
                const sourcePath = path.join(gitFilesFolder, UNTRACKED_CONFIG.untrackedFilesFolderName, branchName, file);
                const destPath = '/project/path/to';
                expect(mockExecCommand).toHaveBeenCalledWith(`mv ${sourcePath} ${destPath}`);
            });
        });

        it('should throw error when path info is missing for a file', async () => {
            const pathInfoObject = {}; // Empty path info
            const branchName = 'main';

            mockGetCurrentBranch.mockResolvedValue(branchName);

            mockFs.readdirSync.mockReturnValue([
                { name: 'test1.txt', isFile: () => true },
                { name: 'pathInfo', isFile: () => true }
            ] as unknown as fs.Dirent[]);

            mockFs.readFileSync.mockReturnValue(Buffer.from(JSON.stringify(pathInfoObject)));

            mockSearchSelect.mockResolvedValue('test1.txt');

            await expect(loadUntracked()).rejects.toThrow('No path information found for file: test1.txt');
        });


    });
});
