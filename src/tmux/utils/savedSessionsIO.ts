import * as fs from 'fs/promises';
import { TmuxSessions } from '@/types/sessionTypes';
import { filterGitKeep } from '@/utils/common';

/**
 * Lists names of saved files in the given folder, excluding .gitkeep.
 */
export async function listSavedNames(folder: string): Promise<string[]> {
    try {
        return filterGitKeep(await fs.readdir(folder));
    } catch (error) {
        console.error('Error reading directory:', error);

        return [];
    }
}

/**
 * Reads and parses a saved sessions file.
 */
export async function readSavedFile(folder: string, name: string): Promise<TmuxSessions> {
    const raw = await fs.readFile(`${folder}/${name}`);

    return JSON.parse(raw.toString());
}

/**
 * Writes a TmuxSessions object as pretty JSON to disk.
 */
export async function writeSavedFile(folder: string, name: string, sessions: TmuxSessions): Promise<void> {
    await fs.writeFile(`${folder}/${name}`, JSON.stringify(sessions, null, 2), 'utf-8');
}

/**
 * Returns true if a saved file with the given name exists in the folder.
 */
export async function savedFileExists(folder: string, name: string): Promise<boolean> {
    try {
        await fs.access(`${folder}/${name}`);

        return true;
    } catch {
        return false;
    }
}
