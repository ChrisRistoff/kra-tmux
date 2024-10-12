import inquirer from 'inquirer';
import autocompletePrompt from 'inquirer-autocomplete-prompt';
import { SearchOptions } from './generalUI';

inquirer.registerPrompt('autocomplete', autocompletePrompt);

export async function searchAndSelectSavedSessions(fileNames: string[]) {
    const searchOptions: SearchOptions = {
        prompt: 'Select a file:',
        itemsArray: fileNames,
    };

    const selectedFile = await searchAndSelectOnlyList(searchOptions);

    if (selectedFile) {
        return selectedFile;
    } else {
        console.log('No option was selected.');
    }
}

export async function searchAndSelectOnlyList(options: SearchOptions): Promise<string | undefined> {
    const { selectedOption } = await inquirer.prompt([
        {
        type: 'autocomplete',
        name: 'selectedOption',
        message: options.prompt,
        source: (_answersSoFar: any, input: string) => {
            if (!input) {
              return options.itemsArray;
            }

            const searchTerm = input.toLowerCase();
            return options.itemsArray.filter(option =>
                option.toLowerCase().includes(searchTerm)
            );
        },
        pageSize: 20,
        },
    ]);

    return selectedOption;
}
