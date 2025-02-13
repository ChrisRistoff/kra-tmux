import * as toml from 'toml';
import * as fs from 'fs/promises';
import { Settings } from '@/types/settingsTypes';

export async function sleep(ms: number): Promise<void> {
        await new Promise(resolve => setTimeout(resolve, ms));
}

export async function loadSettings(): Promise<Settings> {
    const settingsFileString = await fs.readFile(`${__dirname}/../../../settings.toml`, 'utf8');

    return toml.parse(settingsFileString);
}

export function filterGitKeep(array: string[]): string[] {
    return array.filter((item) => item !== '.gitkeep');
}
