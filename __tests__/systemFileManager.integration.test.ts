import * as fs from 'fs';
import * as path from 'path';
import { removeFile, removeDirectory } from '../src/System/SystemFileManager';

// Mock the UI and bash helper modules
jest.mock('../src/UI/generalUI', () => ({
    askUserForInput: jest.fn(),
    promptUserYesOrNo: jest.fn(),
    searchSelectAndReturnFromArray: jest.fn()
}));

jest.mock('../src/helpers/bashHelper', () => ({
    execCommand: jest.fn()
}));

// Import after mocking
import * as ui from '../src/UI/generalUI';
import * as bash from '../src/helpers/bashHelper';

describe('SystemFileManager Integration Tests', () => {
    const TEST_DIR = path.join(process.cwd(), '__tests__/test-files');

    beforeAll(() => {
        if (!fs.existsSync(TEST_DIR)) {
            fs.mkdirSync(TEST_DIR, { recursive: true });
        }
    });

    afterAll(() => {
        if (fs.existsSync(TEST_DIR)) {
            fs.rmSync(TEST_DIR, { recursive: true, force: true });
        }
    });

    beforeEach(() => {
        jest.clearAllMocks();
        // Clear the test directory before each test
        fs.readdirSync(TEST_DIR).forEach(file => {
            const filePath = path.join(TEST_DIR, file);
            fs.rmSync(filePath, { recursive: true, force: true });
        });
    });

    describe('removeFile', () => {
        it('should remove a file when user confirms', async () => {
            // Create test file
            const testFile = path.join(TEST_DIR, 'test.txt');
            fs.writeFileSync(testFile, 'test content');

            // Mock responses
            (ui.askUserForInput as jest.Mock).mockResolvedValue('test');
            (ui.promptUserYesOrNo as jest.Mock).mockResolvedValue(true);
            (ui.searchSelectAndReturnFromArray as jest.Mock).mockResolvedValue(testFile);
            (bash.execCommand as jest.Mock).mockResolvedValueOnce({ stdout: testFile, stderr: '' });

            // Execute
            await removeFile();

            // Verify bash command was called correctly
            expect(bash.execCommand as jest.Mock).toHaveBeenCalledWith(`rm "${testFile}"`);
        });

        it('should not remove file when user cancels', async () => {
            const testFile = path.join(TEST_DIR, 'test.txt');
            fs.writeFileSync(testFile, 'test content');

            (ui.askUserForInput as jest.Mock).mockResolvedValue('test');
            (ui.promptUserYesOrNo as jest.Mock).mockResolvedValue(false);
            (ui.searchSelectAndReturnFromArray as jest.Mock).mockResolvedValue(testFile);
            (bash.execCommand as jest.Mock).mockResolvedValueOnce({ stdout: testFile, stderr: '' });

            await removeFile();

            expect(bash.execCommand as jest.Mock).not.toHaveBeenCalledWith(`rm "${testFile}"`);
            expect(fs.existsSync(testFile)).toBeTruthy();
        });
    });

    describe('removeDirectory', () => {
        it('should remove a directory when user confirms', async () => {
            // Create test directory
            const testDir = path.join(TEST_DIR, 'testdir');
            fs.mkdirSync(testDir);

            (ui.askUserForInput as jest.Mock).mockResolvedValue('testdir');
            (ui.promptUserYesOrNo as jest.Mock).mockResolvedValue(true);
            (ui.searchSelectAndReturnFromArray as jest.Mock).mockResolvedValue(testDir);
            (bash.execCommand as jest.Mock).mockResolvedValueOnce({ stdout: testDir, stderr: '' });

            await removeDirectory();

            expect(bash.execCommand as jest.Mock).toHaveBeenCalledWith(`rm -rf "${testDir}"`);
        });

        it('should handle no matches found', async () => {
            (ui.askUserForInput as jest.Mock).mockResolvedValue('nonexistent');
            (ui.promptUserYesOrNo as jest.Mock).mockResolvedValue(true);
            (bash.execCommand as jest.Mock).mockResolvedValueOnce({ stdout: '', stderr: '' });

            const consoleSpy = jest.spyOn(console, 'log');
            await removeDirectory();

            expect(consoleSpy).toHaveBeenCalledWith('No matches found for the given search criteria.');
            consoleSpy.mockRestore();
        });
    });
});
