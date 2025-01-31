import * as toml from 'toml';
import * as fs from 'fs/promises';

export async function sleep(ms: number): Promise<void> {
        await new Promise(resolve => setTimeout(resolve, ms));
}

export async function loadSettings() {
    const settingsFileString = await fs.readFile(`${__dirname}/../../settings.toml`, 'utf8');

    return toml.parse(settingsFileString);
}
