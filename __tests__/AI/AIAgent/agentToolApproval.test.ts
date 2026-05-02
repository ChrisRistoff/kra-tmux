import path from 'path';
import {
    buildInsertionOnlyEdit,
    extractEditRequest,
    extractWriteRequest,
    getToolArgsRecord,
    getToolFamily,
    shouldAutoApproveTool,
} from '@/AI/AIAgent/shared/utils/agentToolApproval';

describe('agentToolApproval helpers', () => {
    it('auto-approves non-destructive intent reporting', () => {
        expect(shouldAutoApproveTool('bash')).toBe(false);
    });

    it('keeps tool family grouping stable', () => {
        expect(getToolFamily('view')).toBe('view');
    });

    it('extracts writable relative-path tool requests', () => {
        expect(extractWriteRequest({
            path: 'src/file.ts',
            content: 'console.log("hi")\n',
        }, '/tmp/workspace')).toEqual({
            contentField: 'content',
            displayPath: 'src/file.ts',
            nextContent: 'console.log("hi")\n',
            targetPath: path.join('/tmp/workspace', 'src/file.ts'),
        });
    });

    it('extracts writable absolute-path tool requests using newContent', () => {
        expect(extractWriteRequest({
            fileName: '/tmp/output.txt',
            newContent: 'updated',
        }, '/tmp/workspace')).toEqual({
            contentField: 'newContent',
            displayPath: '/tmp/output.txt',
            nextContent: 'updated',
            targetPath: '/tmp/output.txt',
        });
    });

    it('extracts edit tool requests', () => {
        expect(extractEditRequest({
            path: 'src/file.ts',
            old_str: 'before',
            new_str: 'after',
        }, '/tmp/workspace')).toEqual({
            displayPath: 'src/file.ts',
            oldString: 'before',
            newString: 'after',
            targetPath: path.join('/tmp/workspace', 'src/file.ts'),
        });
    });

    it('ignores non-record or non-write tool args', () => {
        expect(getToolArgsRecord(undefined)).toBeUndefined();
        expect(getToolArgsRecord('bash -lc ls')).toBeUndefined();
        expect(extractWriteRequest({ path: 'src/file.ts' }, '/tmp/workspace')).toBeUndefined();
        expect(extractEditRequest({ path: 'src/file.ts' }, '/tmp/workspace')).toBeUndefined();
    });

    it('keeps inserted lines before a closing brace anchor', () => {
        const beforeLines = 'if (x) {\n}\n'.split('\n');
        const afterLines = 'if (x) {\n  work();\n}\n'.split('\n');

        expect(buildInsertionOnlyEdit(beforeLines, afterLines, 1, 1, 2)).toEqual({
            safeLine: 2,
            newContent: '  work();\n}',
        });
    });

    it('avoids an extra blank line when appending into a trailing newline sentinel', () => {
        const beforeLines = 'if (x) {\n}\n'.split('\n');
        const afterLines = 'if (x) {\n}\nnext();\n'.split('\n');

        expect(buildInsertionOnlyEdit(beforeLines, afterLines, 2, 2, 3)).toEqual({
            safeLine: 3,
            newContent: 'next();\n',
        });
    });

    it('keeps the last real line first when appending without a trailing newline', () => {
        const beforeLines = 'if (x) {\n}'.split('\n');
        const afterLines = 'if (x) {\n}\nnext();'.split('\n');

        expect(buildInsertionOnlyEdit(beforeLines, afterLines, 2, 2, 3)).toEqual({
            safeLine: 2,
            newContent: '}\nnext();',
        });
    });
});
