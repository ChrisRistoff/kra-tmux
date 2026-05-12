import path from 'path';
import fs from 'fs';

/**
 * Resolves to the installed kra-workflow package root (the directory that
 * contains package.json). At runtime this file lives at
 * `<pkgRoot>/dest/src/packagePaths.js`, so we walk up two directories.
 *
 * We verify by checking for package.json — guards against odd symlink layouts.
 */
function resolvePackageRoot(): string {
    const candidate = path.resolve(__dirname, '..', '..');
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
        return candidate;
    }

    let dir = __dirname;
    for (let i = 0; i < 6; i++) {
        if (fs.existsSync(path.join(dir, 'package.json'))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }

    return candidate;
}

const PACKAGE_ROOT = resolvePackageRoot();

export function packageRoot(): string {
    return PACKAGE_ROOT;
}

export function assetPath(...segments: string[]): string {
    return path.join(PACKAGE_ROOT, ...segments);
}

// Worker scripts (compiled JS shipped under dest/)
export const loadSessionWorkerPath = assetPath('dest', 'src', 'tmux', 'workers', 'loadSessionWorker.js');

// Automation script directory (raw .sh, .lua source ships in the package tarball)
export const automationScriptsDir = assetPath('automationScripts');
export const sourceAllShPath = path.join(automationScriptsDir, 'source-all.sh');
export const autocompleteShPath = path.join(automationScriptsDir, 'autocomplete', 'autocomplete.sh');
export const tmuxHooksShPath = path.join(automationScriptsDir, 'hooks', 'tmuxHooks.sh');
export const attachTmuxSessionShPath = path.join(automationScriptsDir, 'hooks', 'attachTmuxSession.sh');
export const neovimHooksLuaPath = path.join(automationScriptsDir, 'hooks', 'neovimHooks.lua');


// Compiled autosave entry points
export const autoSaveManagerJsPath = assetPath('dest', 'automationScripts', 'autosave', 'autoSaveManager.js');
export const autosaveJsPath = assetPath('dest', 'automationScripts', 'autosave', 'autosave.js');

// Compiled docs coordinator entry point
export const docsCoordinatorJsPath = assetPath('dest', 'src', 'AI', 'AIAgent', 'shared', 'docs', 'coordinator.js');
export const docsLiveProgressJsPath = assetPath('dest', 'src', 'AI', 'AIAgent', 'shared', 'docs', 'liveProgressCli.js');

// Python worker that wraps Crawl4AI (shipped as raw .py)
export const docsPythonWorkerPath = path.join(automationScriptsDir, 'python', 'kra_docs_worker.py');
export const docsPythonRequirementsPath = path.join(automationScriptsDir, 'python', 'requirements-lean.txt');


// Default settings template that ships with the package
export const settingsExamplePath = assetPath('settings.toml.example');
export const defaultTmuxConfPath = assetPath('tmux-files', '.tmux.conf');

