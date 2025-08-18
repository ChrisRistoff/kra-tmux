import * as toml from 'smol-toml';
import * as fs from 'fs/promises';
import { Settings } from '@/types/settingsTypes';
import { settingsFilePath } from '@/filePaths';

export async function sleep(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
}

export async function loadSettings(): Promise<Settings> {
    const settingsFileString = await fs.readFile(settingsFilePath, 'utf8');

    return toml.parse(settingsFileString) as Settings;
}

export async function saveSettings(settings: Settings) {
    await fs.writeFile(settingsFilePath, toml.stringify(settings));
}

export function filterGitKeep(array: string[]): string[] {
    return array.filter((item) => item !== '.gitkeep');
}
