/**
 * First-run installer for kra-workflow.
 *
 * Idempotent. Performs:
 *   1. Create ~/.kra/ skeleton
 *   2. Migrate from legacy ~/programming/kra-tmux/ if present and ~/.kra is fresh
 *   3. Drop in default settings.toml from settings.toml.example if missing
 *   4. Patch ~/.bashrc and ~/.zshrc with `source <pkg>/automationScripts/source-all.sh`
 *   5. Copy neovimHooks.lua into ~/.config/nvim/lua/ and require it from init.lua
 *   6. Touch ~/.kra/.installed marker so future runs skip the heavy work
 *
 * Safe to re-run; nothing is overwritten.
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { kraHome } from '@/filePaths';
import { packageRoot, sourceAllShPath, neovimHooksLuaPath, settingsExamplePath, defaultTmuxConfPath } from '@/packagePaths';

const LEGACY_PROJECT_ROOT = path.join(os.homedir(), 'programming', 'kra-tmux');
const ASSET_HASHES_FILE = '.asset-hashes.json';

function fileHash(filePath: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function loadHashStore(home: string): Record<string, string> {
    const p = path.join(home, ASSET_HASHES_FILE);
    if (!fs.existsSync(p)) return {};
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

function saveHashStore(home: string, store: Record<string, string>): void {
    fs.writeFileSync(path.join(home, ASSET_HASHES_FILE), JSON.stringify(store, null, 2));
}

/**
 * Copies `src` to `target` on first use, then keeps `target` in sync with
 * future template updates — but only when the user has not modified the file
 * (detected by comparing the target's current hash to the hash we stored when
 * we last wrote it).
 */
function syncManagedFile(
    home: string,
    src: string,
    target: string,
    label: string,
    store: Record<string, string>,
): void {
    if (!fs.existsSync(src)) return;
    const key = path.relative(home, target);
    const srcHash = fileHash(src);

    if (!fs.existsSync(target)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(src, target);
        store[key] = srcHash;
        console.log(`[kra] wrote ${label} from template`);
        return;
    }

    const lastInstalledHash = store[key];
    if (!lastInstalledHash) {
        // First time we're tracking this file; record the current state without overwriting.
        store[key] = fileHash(target);
        return;
    }

    if (srcHash !== lastInstalledHash) {
        const userHash = fileHash(target);
        if (userHash === lastInstalledHash) {
            fs.copyFileSync(src, target);
            store[key] = srcHash;
            console.log(`[kra] updated ${label} to latest template`);
        }
        // User has customised the file — leave it untouched.
    }
}

function copyDirRecursive(src: string, dest: string): void {
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDirRecursive(s, d);
        } else if (entry.isFile() && !fs.existsSync(d)) {
            fs.copyFileSync(s, d);
        }
    }
}

function copyFileIfMissing(src: string, dest: string): void {
    if (!fs.existsSync(src) || fs.existsSync(dest)) return;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
}

function appendLineIfMissing(filePath: string, line: string): boolean {
    if (!fs.existsSync(filePath)) return false;
    const content = fs.readFileSync(filePath, 'utf8');
    if (content.includes(line)) return false;
    fs.appendFileSync(filePath, `\n${line}\n`);

    return true;
}

function ensureKraHomeSkeleton(home: string): boolean {
    const created = !fs.existsSync(home);
    const subdirs = [
        '',
        'git-files',
        'tmux-files/sessions',
        'tmux-files/nvim-sessions',
        'ai-files/chat-history',
        'ai-files/chat-history',
        'system-files/scripts',
        'lock-files',
        'model-catalog',
        'cache/fastembed',
    ];

    for (const sub of subdirs) {
        fs.mkdirSync(path.join(home, sub), { recursive: true });
    }

    return created;
}

function migrateFromLegacy(home: string): void {
    if (!fs.existsSync(LEGACY_PROJECT_ROOT)) return;
    console.log(`[kra] migrating user data from ${LEGACY_PROJECT_ROOT} -> ${home}`);

    const dirCopies: Array<[string, string]> = [
        ['git-files', 'git-files'],
        ['tmux-files', 'tmux-files'],
        ['ai-files', 'ai-files'],
        ['system-files', 'system-files'],
        ['lock-files', 'lock-files'],
    ];

    for (const [src, dst] of dirCopies) {
        copyDirRecursive(path.join(LEGACY_PROJECT_ROOT, src), path.join(home, dst));
    }

    copyFileIfMissing(path.join(LEGACY_PROJECT_ROOT, 'settings.toml'), path.join(home, 'settings.toml'));

    const legacyModelCatalog = path.join(os.homedir(), '.config', 'kra-tmux', 'model-catalog');
    const legacyFastembed = path.join(os.homedir(), '.cache', 'kra-tmux', 'fastembed');
    const legacyQuotaCache = path.join(os.homedir(), '.local', 'share', 'kra-tmux', 'quota-cache.json');
    copyDirRecursive(legacyModelCatalog, path.join(home, 'model-catalog'));
    copyDirRecursive(legacyFastembed, path.join(home, 'cache', 'fastembed'));
    copyFileIfMissing(legacyQuotaCache, path.join(home, 'quota-cache.json'));
}

function ensureDefaultTmuxConf(home: string, store: Record<string, string>): void {
    syncManagedFile(home, defaultTmuxConfPath, path.join(home, 'tmux-files', '.tmux.conf'), '.tmux.conf', store);
}

function countLines(filePath: string): number {
    return fs.readFileSync(filePath, 'utf8').split('\n').length;
}

function ensureDefaultSettings(home: string): void {
    const target = path.join(home, 'settings.toml');
    if (!fs.existsSync(settingsExamplePath)) return;
    if (!fs.existsSync(target)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(settingsExamplePath, target);
        console.log('[kra] wrote default settings.toml from template');
        return;
    }
    // Only overwrite the user's settings when the template has grown or
    // shrunk (new settings added / removed). If line counts match the user
    // may have customised values — leave the file untouched.
    if (countLines(settingsExamplePath) !== countLines(target)) {
        fs.copyFileSync(settingsExamplePath, target);
        console.log('[kra] updated settings.toml to latest template (line count changed)');
    }
}

function patchShellRcs(): void {
    const sourceLine = `source ${sourceAllShPath}`;
    for (const rc of [`${os.homedir()}/.bashrc`, `${os.homedir()}/.zshrc`]) {
        if (appendLineIfMissing(rc, sourceLine)) {
            console.log(`[kra] added kra-workflow source line to ${rc}`);
        }
    }
}

function patchNeovimConfig(): void {
    const nvimLuaDir = path.join(os.homedir(), '.config', 'nvim', 'lua');
    const nvimInit = path.join(os.homedir(), '.config', 'nvim', 'init.lua');
    fs.mkdirSync(nvimLuaDir, { recursive: true });
    const target = path.join(nvimLuaDir, 'neovimHooks.lua');
    if (fs.existsSync(neovimHooksLuaPath)) {
        fs.copyFileSync(neovimHooksLuaPath, target);
    }
    const requireLine = 'require("neovimHooks")';
    if (fs.existsSync(nvimInit)) {
        appendLineIfMissing(nvimInit, requireLine);
    } else if (fs.existsSync(path.dirname(nvimInit))) {
        fs.writeFileSync(nvimInit, `${requireLine}\n`);
    }
}

export interface InstallOptions {
    force?: boolean;
}

export function installedMarkerPath(home: string = kraHome()): string {
    return path.join(home, '.installed');
}

export function isInstalled(): boolean {
    return fs.existsSync(installedMarkerPath());
}

export function runInstall(opts: InstallOptions = {}): void {
    const home = kraHome();

    // Idempotent file-presence checks run unconditionally so that defaults
    // added in newer package versions are seeded for existing installs too.
    const fresh = ensureKraHomeSkeleton(home);
    const hashStore = loadHashStore(home);
    ensureDefaultSettings(home);
    ensureDefaultTmuxConf(home, hashStore);
    saveHashStore(home, hashStore);

    if (isInstalled() && !opts.force) return;

    if (fresh) {
        migrateFromLegacy(home);
    }
    patchShellRcs();
    patchNeovimConfig();

    fs.writeFileSync(installedMarkerPath(home), `installed-from=${packageRoot()}\nat=${new Date().toISOString()}\n`);
    console.log('[kra] setup complete. Restart your shell (or `source ~/.bashrc`) to enable autocompletion.');
}
