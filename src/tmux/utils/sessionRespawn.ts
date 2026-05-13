import * as fs from 'fs/promises';
import * as bash from '@/utils/bashHelper';
import { nvimSessionsPath } from '@/filePaths';
import { Window, SessionResult, TmuxSessions } from '@/types/sessionTypes';

/**
 * Validates window configuration to ensure layout matches pane count
 */
export function validateWindowConfig(window: Window): boolean {
    const paneCount = window.panes.length || 0;

    if (!paneCount) {
        console.warn(`Window ${window.windowName} has no panes`);

        return false;
    }

    if (paneCount === 1) return true;

    if (!window.layout) {
        console.warn(`Window ${window.windowName} has ${paneCount} panes but no layout`);

        return false;
    }

    return true;
}

/**
 * Generates performant tmux script using respawn-pane to bypass shell loading.
 * Creates window/pane structure and configures commands/working directories.
 */
export function generateRespawnScript(
    sessionResults: SessionResult[],
    savedData: TmuxSessions,
    saveName: string,
): string[] {
    const scriptLines: string[] = [];

    for (const result of sessionResults) {
        const sessionConfig = savedData[result.sessionName];

        if (!sessionConfig.windows.length) {
            continue;
        }

        const sortedWindows = [...sessionConfig.windows].sort((a, b) => {
            const aIndex = a.windowIndex ?? sessionConfig.windows.indexOf(a);
            const bIndex = b.windowIndex ?? sessionConfig.windows.indexOf(b);

            return aIndex - bIndex;
        });

        console.log(`Processing ${sortedWindows.length} windows for session ${result.sessionName}`);

        sortedWindows.forEach((window: Window, arrayIndex: number) => {
            if (!validateWindowConfig(window)) {
                console.warn(`Skipping invalid window config: ${window.windowName}`);

                return;
            }

            const tmuxWindowIndex = arrayIndex;
            const windowTarget = `${result.sessionName}:${tmuxWindowIndex}`;

            console.log(`Creating window ${tmuxWindowIndex}: ${window.windowName} with ${window.panes.length} panes`);

            if (tmuxWindowIndex === 0) {
                scriptLines.push(`select-window -t ${result.sessionName}:0`);
                scriptLines.push(`rename-window -t ${result.sessionName}:0 "${window.windowName}"`);
            } else {
                scriptLines.push(`new-window -t ${result.sessionName}:${tmuxWindowIndex} -n "${window.windowName}" -c ~/`);
            }

            if (window.panes.length > 1) {
                for (let i = 1; i < window.panes.length; i++) {
                    scriptLines.push(`split-window -t ${windowTarget} -c ~/`);
                }

                if (window.layout) {
                    scriptLines.push(`select-layout -t ${windowTarget} "${window.layout}"`);
                }
            }

            window.panes.forEach((pane, paneIndex) => {
                const paneTarget = `${windowTarget}.${paneIndex}`;
                const workingDir = pane.currentPath.split('/').slice(3).join('/') || '~';

                if (pane.currentCommand === 'nvim') {
                    const nvimSessionFile = `${nvimSessionsPath}/${saveName}/${result.sessionName}_${tmuxWindowIndex}_${paneIndex}.vim`;
                    const shell = process.env.SHELL ?? '/bin/bash';
                    const nvimCommand = `${shell} -c 'cd "${workingDir}" && (if [ -f "${nvimSessionFile}" ]; then nvim -S "${nvimSessionFile}"; else nvim; fi); exec ${shell}'`;
                    scriptLines.push(`respawn-pane -t ${paneTarget} -k "${nvimCommand}"`);
                } else {
                    const shell = process.env.SHELL ?? '/bin/bash';
                    const shellCommand = `/bin/bash -c 'cd "${workingDir}" && exec ${shell}'`;
                    scriptLines.push(`respawn-pane -t ${paneTarget} -k "${shellCommand}"`);
                }
            });

            scriptLines.push(`select-pane -t ${windowTarget}.0`);
        });

        result.windows = sortedWindows;
    }

    return scriptLines;
}

/**
 * Creates base tmux sessions with minimal shell initialization.
 *
 * @param sessionNames - sessions to create
 * @param options.destroyExisting - if true (default), tear down any existing
 *   session with the same name before creating. Set to false when loading a
 *   single session into a running server and the caller has already decided
 *   how to handle name collisions.
 */
export async function createBaseSessions(
    sessionNames: string[],
    options: { destroyExisting?: boolean } = {},
): Promise<SessionResult[]> {
    const { destroyExisting = true } = options;

    console.log(`Creating ${sessionNames.length} base sessions:`, sessionNames);

    if (destroyExisting) {
        for (const sessionName of sessionNames) {
            try {
                await bash.execCommand(`tmux kill-session -t "${sessionName}" 2>/dev/null || true`);
                console.log(`Cleaned up existing session: ${sessionName}`);
            } catch (_error) {
                /* ignore */
            }
        }
    }

    const results: SessionResult[] = [];

    for (const sessionName of sessionNames) {
        try {
            await bash.execCommand(`tmux new-session -d -s "${sessionName}" -c ~/`);
            await bash.execCommand(`tmux has-session -t "${sessionName}"`);

            const windowList = await bash.execCommand(`tmux list-windows -t "${sessionName}" -F "#{window_index}:#{window_name}"`);
            console.log(`Session ${sessionName} created with windows:`, windowList.stdout.trim());

            results.push({ sessionName, success: true, windows: [] });
        } catch (error) {
            console.error(`Failed to create session ${sessionName}:`, error);
            results.push({ sessionName, success: false, windows: [] });
        }
    }

    console.log(`Successfully created ${results.filter((r) => r.success).length}/${sessionNames.length} sessions`);

    return results;
}

/**
 * Executes tmux script with window indexing safeguards.
 * Creates a temporary script file with base-index configuration and executes it.
 */
export async function executeTmuxScript(scriptLines: string[]): Promise<void> {
    const timestamp = Date.now();
    const scriptPath = `/tmp/tmux_ultra_script_${timestamp}.tmux`;

    const safeguardedScript = [
        '# Ensure base-index is 0 for consistent window numbering',
        'set-option -g base-index 0',
        'set-option -g pane-base-index 0',
        '# Disable automatic window renumbering during script execution',
        'set-option -g renumber-windows off',
        '',
        ...scriptLines,
        '',
        '# Re-enable renumber-windows if it was previously enabled',
        'set-option -g renumber-windows on',
    ];

    const scriptContent = safeguardedScript.join('\n');
    await bash.execCommand(`cat > "${scriptPath}" << 'SCRIPT_EOF'
${scriptContent}
SCRIPT_EOF`);

    try {
        await bash.execCommand(`tmux source-file "${scriptPath}"`);
    } finally {
        await fs.rm(scriptPath);
    }
}
