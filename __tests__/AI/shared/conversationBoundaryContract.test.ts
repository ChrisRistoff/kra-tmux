import * as conversation from '@/AI/shared/conversation';

describe('shared conversation boundary contract', () => {
    it('exposes AI Neovim helper capabilities used by chat and agent flows', () => {
        expect(typeof conversation.generateSocketPath).toBe('function');
        expect(typeof conversation.waitForSocket).toBe('function');
        expect(typeof conversation.addNeovimFunctions).toBe('function');
        expect(typeof conversation.addCommands).toBe('function');
        expect(typeof conversation.setupKeyBindings).toBe('function');
        expect(typeof conversation.updateNvimAndGoToLastLine).toBe('function');
    });

    it('exposes file-context lifecycle APIs through one stable import path', () => {
        expect(Array.isArray(conversation.fileContexts)).toBe(true);
        expect(typeof conversation.handleAddFileContext).toBe('function');
        expect(typeof conversation.showFileContextsPopup).toBe('function');
        expect(typeof conversation.handleRemoveFileContext).toBe('function');
        expect(typeof conversation.clearAllFileContexts).toBe('function');
        expect(typeof conversation.clearFileContexts).toBe('function');
        expect(typeof conversation.getFileContextsForPrompt).toBe('function');
        expect(typeof conversation.getFileExtension).toBe('function');
    });

    it('keeps shared file-context state accessible and resettable via boundary', () => {
        conversation.fileContexts.push({ filePath: '/tmp/a.ts', isPartial: false, summary: 'Full file: a.ts' });
        expect(conversation.fileContexts).toHaveLength(1);

        conversation.clearFileContexts();
        expect(conversation.fileContexts).toHaveLength(0);
    });
});
