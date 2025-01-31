import * as bash from '../helpers/bashHelper';

enum TypeToGrep {
    File = 'f',
    Directory = 'd',
}

export class BaseSystem {
    public async getGreppedFilesArray(name: string, exactMatch: boolean): Promise<string[]> {
        const match = exactMatch ? '' : '*';

        const grepResult = await bash.execCommand(`find . -type ${TypeToGrep.File} -iname "${match}${name}${match}"`);

        const resultsArray = grepResult.stdout.split('\n');
        resultsArray.pop();

        return resultsArray;
    }

    public async getGreppedDirsArray(name: string, exactMatch: boolean): Promise<string[]> {
        const match = exactMatch ? '' : '*';

        const grepResult = await bash.execCommand(`find . -type ${TypeToGrep.Directory} -iname "${match}${name}${match}"`);

        const resultsArray = grepResult.stdout.split('\n');
        resultsArray.pop();

        return resultsArray;
    }
}
