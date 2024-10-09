import inquirer from 'inquirer';

export async function askUserForFileName(branchName: string): Promise<string> {

    if (!branchName) {
        return await askUserForNameOfFile();
    }

    const { proceed }: { proceed: boolean } = await inquirer.prompt([
        {
        type: 'confirm',
        name: 'proceed',
        message: `Do you want to use the branch name: "${branchName}" as session name? Y/N`,
        default: true,
        },
    ]);

    if (!proceed) {
        return await askUserForNameOfFile()
    } else {
        return branchName;
    }
}

async function askUserForNameOfFile() {
    const { name }: { name: string } = await inquirer.prompt([
        {
        type: 'input',
        name: 'name',
        message: 'Please enter session name and press enter:',
        },
    ]);

    return name;

}
