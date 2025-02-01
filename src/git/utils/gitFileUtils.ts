import * as bash from "../../helpers/bashHelper";
import { GIT_COMMANDS } from "../config/gitConstants";

export async function getFileList(command: string): Promise<string[]> {
    const response = await bash.execCommand(command);
    const files = response.stdout.split('\n');
    return files.filter(Boolean); // Removes empty strings
}

export async function getModifiedFiles(): Promise<string[]> {
    return getFileList(GIT_COMMANDS.GET_MODIFIED);
}

export async function getUntrackedFiles(): Promise<string[]> {
    return getFileList(GIT_COMMANDS.GET_UNTRACKED);
}

export async function getConflictedFiles(): Promise<string[]> {
    return getFileList(GIT_COMMANDS.GET_CONFLICTS);
}

export async function getStashes(): Promise<string[]> {
    return getFileList(GIT_COMMANDS.GET_STASHES);
}
