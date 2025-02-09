import inquirer from 'inquirer';
import { geminiModels } from '../data/models';

export async function promptUserForTemperature(model: string) {
    const maxTemp = geminiModels[model] ? 20 : 10;
    const optionsArray: string[] = [];

    for (let i = 0; i <= maxTemp; i++) {
        optionsArray.push(i.toString());
    }

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
                    option.includes(input)
                );
            },
        },
    ]);

    return +selectedOption / 10;
}

export function formatChatEntry(role: string, content: string, topLevel = false): string {
    const timestamp = new Date().toISOString();
    let header = `---\n### ${role} (${timestamp})\n\n`;
    if (topLevel) {
        header = `### ${role} (${timestamp})\n\n`;
    }

    return content ? `${header}${content}\n---\n` : header;
}
