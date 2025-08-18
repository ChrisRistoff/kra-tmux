import * as nvim from '@/utils/neovimHelper';
import * as toml from 'smol-toml';
import * as fs from 'fs/promises';
import { settingsFilePath } from "@/filePaths";

export async function handleChangeSettings(): Promise<void> {
    let settingsFileString = await fs.readFile(settingsFilePath, 'utf8');
    const oldSettings = toml.parse(settingsFileString);

    await nvim.openVim(settingsFilePath);

    settingsFileString = await fs.readFile(settingsFilePath, 'utf8');
    const newSettings = toml.parse(settingsFileString);

    console.log('Changed settings below:');

    for (const setting of Object.keys(oldSettings)) {
        if (oldSettings[setting] !== newSettings[setting]) {
            console.table({
                'Setting': setting
            });
            console.table({
                'Old value': `${oldSettings[setting]}`,
                'New setting': `${newSettings[setting]}`
            });
        }
    }
}
