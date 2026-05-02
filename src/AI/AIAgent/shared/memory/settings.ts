/**
 * Settings loader for the kra-memory layer.
 *
 * Reads the `[ai.agent.memory]` block from `settings.toml` (via the shared
 * settings loader) and fills in defaults. Returned shape is normalised so the
 * rest of the memory layer never has to deal with `undefined`.
 *
 * NOTE: this module is loaded by both the long-lived agent process and the
 * MCP server child. Both share the same defaults.
 */

import fs from 'fs/promises';
import * as toml from 'smol-toml';
import type { MemorySettings } from './types';
import { settingsFilePath } from '@/filePaths';

const DEFAULT_INCLUDE_EXTENSIONS = [
    '.ts', '.tsx', '.mts', '.cts',
    '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.go', '.rs', '.java', '.kt',
    '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp',
    '.rb', '.php', '.lua',
    '.md', '.toml', '.yaml', '.yml', '.json', '.jsonc',
];

// Globs applied to the relative path (POSIX separators).
const DEFAULT_EXCLUDE_GLOBS = [
    'node_modules/**',
    'dest/**',
    'dist/**',
    'build/**',
    'coverage/**',
    '.git/**',
    '.next/**',
    '.cache/**',
    '**/*.min.js',
    '**/*.min.css',
    '**/*.map',
    '**/*.lock',
    '**/package-lock.json',
];

const DEFAULTS: MemorySettings = {
    enabled: true,
    indexCodeOnStart: false,
    indexCodeOnSave: false,
    autoSurfaceOnStart: false,
    gitignoreMemory: true,
    includeExtensions: DEFAULT_INCLUDE_EXTENSIONS,
    excludeGlobs: DEFAULT_EXCLUDE_GLOBS,
    chunkLines: 80,
    chunkOverlap: 5,
};

interface RawMemorySettings {
    enabled?: boolean;
    indexCodeOnStart?: boolean;
    indexCodeOnSave?: boolean;
    autoSurfaceOnStart?: boolean;
    gitignoreMemory?: boolean;
    includeExtensions?: string[];
    excludeGlobs?: string[];
    chunkLines?: number;
    chunkOverlap?: number;
}

export async function loadMemorySettings(): Promise<MemorySettings> {
    let raw: RawMemorySettings = {};

    try {
        const content = await fs.readFile(settingsFilePath, 'utf8');
        const parsed = toml.parse(content) as { ai?: { agent?: { memory?: RawMemorySettings } } };
        const memory = parsed.ai?.agent?.memory;

        if (memory && typeof memory === 'object') raw = memory;
    } catch {
        // settings.toml not present yet — fall back to defaults.
    }

    return {
        enabled: raw.enabled ?? DEFAULTS.enabled,
        indexCodeOnStart: raw.indexCodeOnStart ?? DEFAULTS.indexCodeOnStart,
        indexCodeOnSave: raw.indexCodeOnSave ?? DEFAULTS.indexCodeOnSave,
        autoSurfaceOnStart: raw.autoSurfaceOnStart ?? DEFAULTS.autoSurfaceOnStart,
        gitignoreMemory: raw.gitignoreMemory ?? DEFAULTS.gitignoreMemory,
        includeExtensions: Array.isArray(raw.includeExtensions) && raw.includeExtensions.length > 0
            ? raw.includeExtensions.map(normaliseExt)
            : DEFAULTS.includeExtensions,
        excludeGlobs: Array.isArray(raw.excludeGlobs) && raw.excludeGlobs.length > 0
            ? raw.excludeGlobs
            : DEFAULTS.excludeGlobs,
        chunkLines: clampInt(raw.chunkLines, 20, 400, DEFAULTS.chunkLines),
        chunkOverlap: clampInt(raw.chunkOverlap, 0, 50, DEFAULTS.chunkOverlap),
    };
}

function normaliseExt(ext: string): string {
    return ext.startsWith('.') ? ext : `.${ext}`;
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    const i = Math.round(value);

    if (i < min) return min;
    if (i > max) return max;

    return i;
}
