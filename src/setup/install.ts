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

import * as toml from 'smol-toml';
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

const LAST_TMUX_TEMPLATE_FILE = '.last-tmux-template';

function ensureDefaultTmuxConf(home: string): void {
    const target           = path.join(home, 'tmux-files', '.tmux.conf');
    const lastTemplatePath = path.join(home, LAST_TMUX_TEMPLATE_FILE);
    if (!fs.existsSync(defaultTmuxConfPath)) return;

    const templateText = fs.readFileSync(defaultTmuxConfPath, 'utf8');

    if (!fs.existsSync(target)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(defaultTmuxConfPath, target);
        fs.writeFileSync(lastTemplatePath, templateText);
        console.log('[kra] wrote .tmux.conf from template');

        return;
    }

    if (!fs.existsSync(lastTemplatePath)) {
        // First time we’re tracking this file — save the current template as
        // the baseline without touching the user’s file.
        fs.writeFileSync(lastTemplatePath, templateText);

        return;
    }

    const lastTemplate = fs.readFileSync(lastTemplatePath, 'utf8');
    if (lastTemplate === templateText) return; // nothing changed

    // Find lines that are genuinely new in the template (not present in the
    // last-installed version). We never re-add lines the user removed.
    const lastLines = new Set(lastTemplate.split('\n'));
    const userText  = fs.readFileSync(target, 'utf8');
    const userLines = new Set(userText.split('\n').map(l => l.trim()));

    const linesToAppend = templateText
        .split('\n')
        .filter(l => !lastLines.has(l) && !userLines.has(l.trim()));

    if (linesToAppend.length > 0) {
        fs.appendFileSync(target, '\n# kra: settings added by template update\n' + linesToAppend.join('\n') + '\n');
        console.log('[kra] appended new .tmux.conf settings from template update');
    }

    fs.writeFileSync(lastTemplatePath, templateText);
}

interface TomlBlock {
    header: string;
    isArrayTable: boolean;
    alias: string | undefined;
    text: string;
}

function splitTemplateIntoBlocks(templateText: string): TomlBlock[] {
    const lines = templateText.split('\n');
    const blocks: TomlBlock[] = [];
    let currentLines: string[] = [];
    let currentHeader: string | null = null;
    let currentIsArray = false;
    const headerRe = /^\[\[([^\]]+)\]\]$|^\[([^\]]+)\]$/;

    for (const line of lines) {
        const m = line.trim().match(headerRe);
        if (m) {
            if (currentHeader !== null && currentLines.length > 0) {
                const text = currentLines.join('\n');
                const aliasMatch = text.match(/^alias\s*=\s*["']([^"']+)["']/m);
                blocks.push({ header: currentHeader, isArrayTable: currentIsArray, alias: aliasMatch?.[1], text });
            }
            currentHeader = m[1] || m[2];
            currentIsArray = m[1] !== undefined;
            currentLines = [line];
        } else {
            currentLines.push(line);
        }
    }

    if (currentHeader !== null && currentLines.length > 0) {
        const text = currentLines.join('\n');
        const aliasMatch = text.match(/^alias\s*=\s*["']([^"']+)["']/m);
        blocks.push({ header: currentHeader, isArrayTable: currentIsArray, alias: aliasMatch?.[1], text });
    }

    return blocks;
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

    const templateText = fs.readFileSync(settingsExamplePath, 'utf8');
    const userText = fs.readFileSync(target, 'utf8');

    // Bail out early if either file doesn't parse as valid TOML.
    try {
        toml.parse(templateText);
        toml.parse(userText);
    } catch {
        return;
    }

    const blocksToAppend: string[] = [];

    for (const block of splitTemplateIntoBlocks(templateText)) {
        if (block.isArrayTable) {
            // [[ai.docs.sources]] etc. — deduplicate by alias value.
            if (block.alias) {
                const aliasRe = new RegExp(`alias\\s*=\\s*["']${block.alias}["']`);
                if (!aliasRe.test(userText)) blocksToAppend.push(block.text);
            }
        } else {
            // [section] — append only if the exact header is absent.
            const escaped = block.header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const headerRe = new RegExp(`^\\[${escaped}\\]\\s*$`, 'm');
            if (!headerRe.test(userText)) blocksToAppend.push(block.text);
        }
    }

    if (blocksToAppend.length > 0) {
        fs.appendFileSync(target, '\n' + blocksToAppend.join('\n'));
        console.log('[kra] appended new settings sections to settings.toml');
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
    ensureDefaultSettings(home);
    ensureDefaultTmuxConf(home);

    if (isInstalled() && !opts.force) return;

    if (fresh) {
        migrateFromLegacy(home);
    }
    patchShellRcs();
    patchNeovimConfig();

    fs.writeFileSync(installedMarkerPath(home), `installed-from=${packageRoot()}\nat=${new Date().toISOString()}\n`);
    console.log('[kra] setup complete. Restart your shell (or `source ~/.bashrc`) to enable autocompletion.');
}
