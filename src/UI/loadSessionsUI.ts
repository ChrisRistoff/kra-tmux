import inquirer from 'inquirer';
import autocompletePrompt from 'inquirer-autocomplete-prompt';

inquirer.registerPrompt('autocomplete', autocompletePrompt);

type SearchOptions = {
  prompt: string;
  itemsArray: string[];
}

export async function searchAndSelectSavedSessions(fileNames: string[]) {
    const searchOptions: SearchOptions = {
        prompt: 'Select a file:',
        itemsArray: fileNames,
    };

    const selectedFile = await searchAndSelect(searchOptions);

    if (selectedFile) {
        return selectedFile;
    } else {
        console.log('No option was selected.');
    }
}

export async function searchAndSelect(options: SearchOptions): Promise<string | undefined> {
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
