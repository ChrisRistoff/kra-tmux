import inquirer from 'inquirer';
import autocompletePrompt from 'inquirer-autocomplete-prompt';

inquirer.registerPrompt('autocomplete', autocompletePrompt);

export type SearchOptions = {
  prompt: string;
  itemsArray: string[];
}

export async function promptUserYesOrNo(message: string): Promise<boolean> {
    const { proceed }: { proceed: boolean } = await inquirer.prompt([
        {
        type: 'confirm',
        name: 'proceed',
        message,
        default: true,
        },
    ]);

    return proceed;
}

export async function askUserForInput(message: string): Promise<string> {
    const { name }: { name: string } = await inquirer.prompt([
        {
        type: 'input',
        name: 'name',
        message,
        },
    ]);

    return name;
}

export async function searchAndSelect(options: SearchOptions): Promise<string> {
    let currentUserInput;

    const { userSelection } = await inquirer.prompt([
        {
            type: 'autocomplete',
            name: 'userSelection',
            message: options.prompt,
            source: async (_answersSoFar: string[], input: string) => {
                if (!input) {
                    return options.itemsArray;
                }

                currentUserInput = input;

                const searchTerm = input.toLowerCase();
                const filtered = options.itemsArray.filter(option =>
                    option.toLowerCase().includes(searchTerm)
                );

                if (filtered.length === 0) {
                    return [input];
                }

                return filtered;
            },
            pageSize: 20,
        },
    ]);

    if (!currentUserInput || userSelection === currentUserInput) {
        return userSelection;
    }

    const { finalChoice } = await inquirer.prompt([
        {
            type: 'list',
            name: 'finalChoice',
            message: `Which one do you want to use for the name of your save?`,
            choices: [
                { name: `Use your input: "${currentUserInput}"`, value: currentUserInput},
                { name: `Use your selection: ${userSelection}`, value: userSelection }
            ],
        },
    ]);

    return finalChoice;
}

export async function searchSelectAndReturnFromArray(options: SearchOptions): Promise<string> {
    const { selectedOption } = await inquirer.prompt([
        {
        type: 'autocomplete',
        name: 'selectedOption',
        message: options.prompt,
        source: (_answersSoFar: string[], input: string) => {
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
