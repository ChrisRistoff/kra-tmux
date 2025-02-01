import * as bash from '../helpers/bashHelper';
import * as ui from '../UI/generalUI';

enum SearchTargetType {
    File = 'f',
    Directory = 'd',
}

type SearchCriteria = {
    searchString: string,
    exactMatch: boolean,
}

export async function removeFile(): Promise<void> {
    const fileToRemove = await selectFromMatchingFiles();

    if (!fileToRemove) {
        return;
    }

    await bash.execCommand(`rm ${fileToRemove}`);
}

export async function removeDirectory(): Promise<void> {
    const dirToRemove = await selectFromMatchingDirectories();

    if (!dirToRemove) {
        return;
    }

    await bash.execCommand(`rm -rf ${dirToRemove}`);
}

async function selectFromMatchingFiles(): Promise<string> {
    const stringAndMatch = await getSearchCriteria();

    const files = await searchFilesByName(stringAndMatch.searchString, stringAndMatch.exactMatch);

    if (!files.length) {
        return '';
    }

    const fileName = await ui.searchSelectAndReturnFromArray({
        itemsArray: files,
        prompt: 'Pick the file you want to remove:'
    });

    return fileName;
}

async function selectFromMatchingDirectories(): Promise<string> {
    const stringAndMatch = await getSearchCriteria();

    const files = await searchDirectoriesByName(stringAndMatch.searchString, stringAndMatch.exactMatch);

    if (!files.length) {
        return '';
    }

    const dirPath = await ui.searchSelectAndReturnFromArray({
        itemsArray: files,
        prompt: 'Pick the directory you want to remove:'
    });

    return dirPath;
}

async function getSearchCriteria(): Promise<SearchCriteria> {
    return {
        searchString: await promptForSearchString(),
        exactMatch: await promptExactMatchPreference(),
    }
}

async function searchFilesByName(name: string, exactMatch: boolean): Promise<string[]> {
    const match = exactMatch ? '' : '*';

    const grepResult = await bash.execCommand(`find . -type ${SearchTargetType.File} -iname "${match}${name}${match}"`);

    const resultsArray = grepResult.stdout.split('\n');
    resultsArray.pop();

    return resultsArray;
}

async function searchDirectoriesByName(name: string, exactMatch: boolean): Promise<string[]> {
    const match = exactMatch ? '' : '*';

    const grepResult = await bash.execCommand(`find . -type ${SearchTargetType.Directory} -iname "${match}${name}${match}"`);

    const resultsArray = grepResult.stdout.split('\n');
    resultsArray.pop();

    return resultsArray;
}

async function promptForSearchString(): Promise<string> {
    return await ui.askUserForInput('Enter a word to search for:');
}

async function promptExactMatchPreference(): Promise<boolean> {
    return await ui.promptUserYesOrNo('Do you want to grep for exact match?');
}
