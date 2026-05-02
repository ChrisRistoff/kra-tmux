import os from 'os';
import path from 'path';

/**
 * Resolves the user-data root for kra-workflow. Defaults to ~/.kra; can be
 * overridden by setting the KRA_HOME environment variable (useful for
 * dotfiles repos or testing).
 */
export function kraHome(): string {
    return process.env.KRA_HOME || path.join(os.homedir(), '.kra');
}

const root = kraHome();

//settings
export const settingsFilePath = path.join(root, 'settings.toml');

// git
export const gitFilesFolder = path.join(root, 'git-files');

// tmux
export const sessionFilesFolder = path.join(root, 'tmux-files', 'sessions');

// nvim
export const nvimSessionsPath = path.join(root, 'tmux-files', 'nvim-sessions');

// ai
export const aiHistoryPath = path.join(root, 'ai-files', 'chat-history');

// Agent neovim UI (init.lua + lua/) ships with the package — see packagePaths.
export { aiInitLuaPath as neovimConfig, aiLuaDir } from './packagePaths';

// system
export const systemFilesPath = path.join(root, 'system-files');
export const systemScriptsPath = path.join(root, 'system-files', 'scripts');

// lock
export const lockFilesPath = path.join(root, 'lock-files');

// AI paths consolidated under ~/.kra (previously under ~/.config, ~/.cache, ~/.local/share)
export const modelCatalogDir = path.join(root, 'model-catalog');
export const fastembedCacheDir = path.join(root, 'cache', 'fastembed');
export const quotaCachePath = path.join(root, 'quota-cache.json');

// Crawl4AI venv used by the docs pipeline (created via `kra ai docs` → Setup)
export const crawl4aiVenvDir = path.join(root, 'crawl4ai-venv');
export const crawl4aiVenvPython = path.join(crawl4aiVenvDir, 'bin', 'python');
export const crawl4aiInstalledMarker = path.join(crawl4aiVenvDir, '.installed');

// Centralized kra-memory storage (registry + per-repo lance + global docs).
export const kraMemoryRoot = path.join(root, '.kra-memory');
export const kraMemoryRegistryPath = path.join(kraMemoryRoot, 'registry.json');
export function kraMemoryRepoRoot(repoKey: string): string {
    return path.join(kraMemoryRoot, 'repos', repoKey);
}

// Global docs storage shared by all repos (doc_chunks LanceDB table + crawl state).
export const kraDocsRoot = path.join(kraMemoryRoot, 'docs');
export const kraDocsLanceRoot = path.join(kraDocsRoot, 'lance');
export const kraDocsStatePath = path.join(kraDocsRoot, 'docs-state.json');
export const kraDocsStatusPath = path.join(kraDocsRoot, 'docs-status.json');

// Re-export for backwards compatibility — actual location is packagePaths.ts
export { loadSessionWorkerPath } from './packagePaths';
