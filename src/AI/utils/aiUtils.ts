import { TempFiles } from '../types/aiTypes';
import inquirer from 'inquirer';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

export async function createTempFiles(): Promise<TempFiles> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-prompt-'))

    return {
        promptFile: path.join(tmpDir, 'prompt.txt'),
        responseFile: path.join(tmpDir, 'response.txt'),
    }
}

export async function promptUserForTemperature() {
    const optionsArray = Array.from({length: 10}, (_, i) => (i + 1).toString());
    const { selectedOption } = await inquirer.prompt([
        {
            type: 'autocomplete',
            name: 'selectedOption',
            message: 'Choose temperatur 1-10(0.1 - 1.0)',
            source: (_answersSoFar: string[], input: string) => {
                if (!input) {
                  return optionsArray
                }

                return optionsArray.filter(option =>
                    option.toLowerCase().includes(input)
                );
            },
        },
    ]);

    return selectedOption;
}
