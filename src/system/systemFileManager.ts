import * as bash from '../utils/bashHelper';
import * as ui from '../UI/generalUI';

enum SearchTargetType {
    File = 'f',
    Directory = 'd',
}

interface SearchCriteria {
    searchString: string;
    exactMatch: boolean;
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
    const searchString = (await ui.askUserForInput(SYSTEM_CONSTANTS.MESSAGES.SEARCH_INPUT)).trim();
    const exactMatch = await ui.promptUserYesOrNo(SYSTEM_CONSTANTS.MESSAGES.EXACT_MATCH);

    return {
        searchString,
        exactMatch,
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
        prompt: SYSTEM_CONSTANTS.MESSAGES.DIR_PROMPT
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
        prompt: SYSTEM_CONSTANTS.MESSAGES.DIR_PROMPT
    });
};

export const removeFile = async (): Promise<void> => {
    try {
        const fileToRemove = await selectFromMatchingFiles();

        if (!fileToRemove) {
            console.log(SYSTEM_CONSTANTS.MESSAGES.NO_RESULTS);
            return;
        }

        const confirmed = await ui.promptUserYesOrNo(SYSTEM_CONSTANTS.MESSAGES.CONFIRM_FILE_DELETE);

        if (!confirmed) {
            return;
        }

        await bash.execCommand(`rm "${fileToRemove}"`);
    } catch (error) {
        throw new Error(`Failed to remove file: ${(error as Error).message}`);
    }
};

export const removeDirectory = async (): Promise<void> => {
    try {
        const dirToRemove = await selectFromMatchingDirectories();

        if (!dirToRemove) {
            console.log(SYSTEM_CONSTANTS.MESSAGES.NO_RESULTS);
            return;
        }

        const confirmed = await ui.promptUserYesOrNo(SYSTEM_CONSTANTS.MESSAGES.CONFIRM_DIR_DELETE);

        if (!confirmed) {
            return;
        }

        await bash.execCommand(`rm -rf "${dirToRemove}"`);
    } catch (error) {
        throw new Error(`Failed to remove directory: ${(error as Error).message}`);
    }
};
