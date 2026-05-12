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

import fs from 'fs';
import os from 'os';
import path from 'path';
import { kraHome } from '@/filePaths';
import { packageRoot, sourceAllShPath, neovimHooksLuaPath, settingsExamplePath, defaultTmuxConfPath } from '@/packagePaths';

const LEGACY_PROJECT_ROOT = path.join(os.homedir(), 'programming', 'kra-tmux');

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

function ensureDefaultTmuxConf(home: string): void {
    const target = path.join(home, 'tmux-files', '.tmux.conf');
    if (fs.existsSync(target)) return;
    if (fs.existsSync(defaultTmuxConfPath)) {
        fs.copyFileSync(defaultTmuxConfPath, target);
        console.log('[kra] wrote default .tmux.conf from template');
    }
}

function ensureDefaultSettings(home: string): void {
    const target = path.join(home, 'settings.toml');
    if (fs.existsSync(target)) return;
    if (fs.existsSync(settingsExamplePath)) {
        fs.copyFileSync(settingsExamplePath, target);
        console.log(`[kra] wrote default settings.toml from template`);
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
    if (isInstalled() && !opts.force) return;

    const fresh = ensureKraHomeSkeleton(home);
    if (fresh) {
        migrateFromLegacy(home);
    }
    ensureDefaultSettings(home);
    ensureDefaultTmuxConf(home);
    patchShellRcs();
    patchNeovimConfig();

    fs.writeFileSync(installedMarkerPath(home), `installed-from=${packageRoot()}\nat=${new Date().toISOString()}\n`);
    console.log('[kra] setup complete. Restart your shell (or `source ~/.bashrc`) to enable autocompletion.');
}
