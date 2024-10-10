import inquirer from 'inquirer';

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
