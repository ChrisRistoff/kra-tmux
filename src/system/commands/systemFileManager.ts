import * as bash from '@/utils/bashHelper';
import * as ui from '@/UI/generalUI';
import { SearchCriteria } from '@/system/types/systemFileTypes';
import { menuChain, UserCancelled } from '@/UI/menuChain';

enum SearchTargetType {
    File = 'f',
    Directory = 'd',
}

const SYSTEM_CONSTANTS = {
    MESSAGES: {
        FILE_PROMPT: 'Pick the file you want to remove:',
        DIR_PROMPT: 'Pick the directory you want to remove:',
        SEARCH_INPUT: 'Enter a search term (minimum 2 characters):',
        EXACT_MATCH: 'Do you want to search for exact match?',
        NO_RESULTS: 'No matches found for the given search criteria.',
        CONFIRM_FILE_DELETE: 'Are you sure you want to delete this file?',
        CONFIRM_DIR_DELETE: 'Are you sure you want to delete this directory and all its contents?',
    },
    VALIDATION: {
        MIN_SEARCH_LENGTH: 2,
    }
} as const;

const isValidSearchTerm = (term: string, type: SearchTargetType): boolean => {
    if (type === SearchTargetType.Directory) {
        return term !== undefined && term !== null;
    }

    return Boolean(term && term.length >= SYSTEM_CONSTANTS.VALIDATION.MIN_SEARCH_LENGTH);
};

const sanitizeSearchTerm = (term: string): string => {
    return term.replace(/['"\\]/g, '');
};

const searchByName = async (
    name: string,
    exactMatch: boolean,
    type: SearchTargetType
): Promise<string[]> => {
    if (!isValidSearchTerm(name, type)) {
        throw new Error(`Search term must be at least ${SYSTEM_CONSTANTS.VALIDATION.MIN_SEARCH_LENGTH} characters long`);
    }

    try {
        const match = exactMatch ? '' : '*';
        const sanitizedName = sanitizeSearchTerm(name);

        const grepResult = await bash.execCommand(
            `find . -type ${type} -iname "${match}${sanitizedName}${match}"`
        );

        return grepResult.stdout.split('\n').filter(Boolean);
    } catch (error) {
        throw new Error(`Search failed: ${(error as Error).message}`);
    }
};

const getSearchCriteria = async (): Promise<SearchCriteria> => {
    const { searchString, exactMatch } = await menuChain()
        .step('searchString', async () => ui.askUserForInput(SYSTEM_CONSTANTS.MESSAGES.SEARCH_INPUT))
        .step('exactMatch', async () => ui.promptUserYesOrNo(SYSTEM_CONSTANTS.MESSAGES.EXACT_MATCH))
        .run();

    return {
        searchString: (searchString).trim(),
        exactMatch: exactMatch,
    };
};

const selectFromMatchingFiles = async (): Promise<string | null> => {
    const criteria = await getSearchCriteria();
    const matchingFiles = await searchByName(
        criteria.searchString,
        criteria.exactMatch,
        SearchTargetType.File
    );

    if (!matchingFiles.length) {
        return null;
    }

    return await ui.searchSelectAndReturnFromArray({
        itemsArray: matchingFiles,
        prompt: SYSTEM_CONSTANTS.MESSAGES.FILE_PROMPT,
        header: `${matchingFiles.length} matching file(s)`,
        details: async (file) => {
            try {
                const stat = await bash.execCommand(`ls -la ${JSON.stringify(file)}`);
                const head = await bash.execCommand(`head -n 60 ${JSON.stringify(file)}`).catch(() => ({ stdout: '' }));

                return `${stat.stdout}\n--- preview ---\n${head.stdout}`;
            } catch (e: unknown) {
                return `Failed to stat: ${e instanceof Error ? e.message : String(e)}`;
            }
        },
    });
};

const selectFromMatchingDirectories = async (): Promise<string | null> => {
    const criteria = await getSearchCriteria();
    const matchingDirs = await searchByName(
        criteria.searchString,
        criteria.exactMatch,
        SearchTargetType.Directory
    );

    if (!matchingDirs.length) {
        return null;
    }

    return await ui.searchSelectAndReturnFromArray({
        itemsArray: matchingDirs,
        prompt: SYSTEM_CONSTANTS.MESSAGES.DIR_PROMPT,
        header: `${matchingDirs.length} matching directory(s)`,
        details: async (dir) => {
            try {
                const ls = await bash.execCommand(`ls -la ${JSON.stringify(dir)}`);
                const du = await bash.execCommand(`du -sh ${JSON.stringify(dir)} 2>/dev/null`).catch(() => ({ stdout: '' }));

                return `${du.stdout}\n${ls.stdout}`;
            } catch (e: unknown) {
                return `Failed to stat: ${e instanceof Error ? e.message : String(e)}`;
            }
        },
    });
};

export const removeFile = async (): Promise<void> => {
    try {
        const { fileToRemove, confirmed } = await menuChain()
            .step('fileToRemove', async () => {
                const f = await selectFromMatchingFiles();
                if (!f) {
                    console.log(SYSTEM_CONSTANTS.MESSAGES.NO_RESULTS);
                    throw new UserCancelled();
                }

                return f;
            })
            .step('confirmed', async () => ui.promptUserYesOrNo(SYSTEM_CONSTANTS.MESSAGES.CONFIRM_FILE_DELETE))
            .run();

        if (!confirmed) return;

        await bash.execCommand(`rm "${fileToRemove}"`);
    } catch (error) {
        if (error instanceof UserCancelled) throw error;
        throw new Error(`Failed to remove file: ${(error as Error).message}`);
    }
};

export const removeDirectory = async (): Promise<void> => {
    try {
        const { dirToRemove, confirmed } = await menuChain()
            .step('dirToRemove', async () => {
                const d = await selectFromMatchingDirectories();
                if (!d) {
                    console.log(SYSTEM_CONSTANTS.MESSAGES.NO_RESULTS);
                    throw new UserCancelled();
                }

                return d;
            })
            .step('confirmed', async () => ui.promptUserYesOrNo(SYSTEM_CONSTANTS.MESSAGES.CONFIRM_DIR_DELETE))
            .run();

        if (!confirmed) return;

        await bash.execCommand(`rm -rf "${dirToRemove}"`);
    } catch (error) {
        if (error instanceof UserCancelled) throw error;
        throw new Error(`Failed to remove directory: ${(error as Error).message}`);
    }
};
