import * as fs from 'fs/promises';
import * as nvim from '@/utils/neovimHelper';
import { nvimSessionsPath } from '@/filePaths';
import { TmuxSessions } from '@/types/sessionTypes';

/**
 * Saves nvim panes for every nvim-running pane in the provided sessions.
 * Used by both server-level and session-level save flows.
 */
export async function saveNvimForSessions(sessions: TmuxSessions, saveFileName: string): Promise<void> {
    for (const [sessionName, session] of Object.entries(sessions)) {
        for (const [windowIndex, window] of session.windows.entries()) {
            for (const [paneIndex, pane] of window.panes.entries()) {
                if (pane.currentCommand === 'nvim') {
                    await nvim.saveNvimSession(saveFileName, sessionName, windowIndex, paneIndex);
                }
            }
        }
    }
}

/**
 * Removes stale nvim session files for panes that are no longer running nvim.
 * Iterates the provided sessions snapshot and unlinks per-pane files that
 * don't correspond to a current nvim pane.
 */
export function cleanUpStaleNvimSaves(sessions: TmuxSessions): void {
    Object.keys(sessions).forEach((session) => {
        sessions[session].windows.forEach((window, windowIndex) => {
            window.panes.forEach(async (pane, paneIndex): Promise<void> => {
                if (pane.currentCommand !== 'nvim') {
                    const nvimSessionFileName = `${session}_${windowIndex}_${paneIndex}`;
                    try {
                        await fs.rm(`${nvimSessionsPath}/${nvimSessionFileName}`);
                    } catch (_err) {
                        /* noop */
                    }
                }
            });
        });
    });
}
