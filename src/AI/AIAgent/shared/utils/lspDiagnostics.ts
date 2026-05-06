/**
 * Lightweight TypeScript diagnostics for the agent's edit/create tools.
 *
 * Uses the in-process TypeScript Compiler API (already a dep) instead of
 * spawning typescript-language-server — no JSON-RPC, no extra binary, and
 * we share the LanguageService across edits in the same session so warm
 * checks are sub-second.
 *
 * Public entry points:
 *   - getDiagnosticsForProject(filePath) — runs a project-wide check (errors
 *     across every TS source under the project's tsconfig, plus warnings on
 *     the just-edited file). Returns a formatted block, with a net-change
 *     footer when the error count moved since the last edit, or undefined
 *     when there are no errors and no resolved errors to announce.
 *   - getDiagnosticsForFile(filePath) — single-file errors+warnings. Kept
 *     for callers that want the cheap path (e.g. fallback / tests).
 *
 * The MCP server appends the project-scope result to edit / create_file
 * responses so the agent sees the full type picture in the same turn it
 * made the change — no need for it to run `tsc` separately.
 */

import * as ts from 'typescript';
import * as path from 'path';
import * as fs from 'fs';

const TS_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

const MAX_DIAGNOSTICS = 20;
const MAX_PROJECT_DIAGNOSTICS = 30;

export function isTsLikeFile(filePath: string): boolean {
    return TS_EXTS.has(path.extname(filePath).toLowerCase());
}

interface IProject {
    rootDir: string;
    configPath: string | undefined;
    compilerOptions: ts.CompilerOptions;
    rootFiles: Set<string>;
    fileVersions: Map<string, number>;
    // Last-seen mtime per file. Used to detect on-disk changes so we can
    // bump fileVersions and force the TS LanguageService to re-parse files
    // we did not directly edit (otherwise its internal AST cache, keyed by
    // (path, version), serves stale diagnostics for cross-file dependents).
    fileMtimes: Map<string, number>;
    fileSnapshots: Map<string, string>;
    service: ts.LanguageService;
    // -1 means "never measured"; used for the net-change footer so the agent
    // gets explicit positive feedback when an edit fixes errors.
    lastErrorCount: number;
}

const projects = new Map<string, IProject>();

function loadProject(filePath: string): IProject | undefined {
    const configPath = ts.findConfigFile(path.dirname(filePath), ts.sys.fileExists, 'tsconfig.json');
    const rootDir = configPath ? path.dirname(configPath) : path.dirname(filePath);
    const key = configPath ?? rootDir;

    const existing = projects.get(key);
    if (existing) return existing;

    let compilerOptions: ts.CompilerOptions = ts.getDefaultCompilerOptions();
    let rootFiles = new Set<string>();

    if (configPath) {
        const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
        if (configFile.error || !configFile.config) return undefined;

        const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, rootDir, undefined, configPath);
        compilerOptions = parsed.options;
        rootFiles = new Set(parsed.fileNames.map((f) => path.resolve(f)));
    }

    const project: IProject = {
        rootDir,
        configPath,
        compilerOptions,
        rootFiles,
        fileVersions: new Map(),
        fileSnapshots: new Map(),
        fileMtimes: new Map(),
        // Set after host construction below.
        service: null as unknown as ts.LanguageService,
        lastErrorCount: -1,
    };

    const host: ts.LanguageServiceHost = {
        getScriptFileNames: () => Array.from(new Set([...project.rootFiles, ...project.fileSnapshots.keys()])),
        getScriptVersion: (f) => String(project.fileVersions.get(path.resolve(f)) ?? 0),
        getScriptSnapshot: (f) => {
            const abs = path.resolve(f);
            const snap = project.fileSnapshots.get(abs);
            if (snap !== undefined) return ts.ScriptSnapshot.fromString(snap);
            if (!ts.sys.fileExists(abs)) return undefined;

            return ts.ScriptSnapshot.fromString(ts.sys.readFile(abs) ?? '');
        },
        getCurrentDirectory: () => rootDir,
        getCompilationSettings: () => compilerOptions,
        getDefaultLibFileName: ts.getDefaultLibFilePath,
        fileExists: ts.sys.fileExists,
        readFile: ts.sys.readFile,
        readDirectory: ts.sys.readDirectory,
        directoryExists: ts.sys.directoryExists,
        getDirectories: ts.sys.getDirectories,
    };

    project.service = ts.createLanguageService(host, ts.createDocumentRegistry());
    projects.set(key, project);

    return project;
}

function formatDiagnosticBody(d: ts.Diagnostic): string {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n    ');
    const sev = d.category === ts.DiagnosticCategory.Error ? 'error' : 'warning';
    if (d.file && d.start !== undefined) {
        const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);

        return `L${line + 1}:${character + 1}  ${sev} TS${d.code}: ${msg}`;
    }

    return `${sev} TS${d.code}: ${msg}`;
}

function formatDiagnostic(d: ts.Diagnostic): string {
    return `  ${formatDiagnosticBody(d)}`;
}

function isUnderProjectRoot(absPath: string, rootDir: string): boolean {
    const rel = path.relative(rootDir, absPath);
    if (rel === '' ) return true;
    if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
    if (rel.split(path.sep).includes('node_modules')) return false;

    return true;
}

function isCheckableProjectFile(absPath: string, rootDir: string): boolean {
    if (!isUnderProjectRoot(absPath, rootDir)) return false;
    if (absPath.endsWith('.d.ts')) return false;

    return true;
}

/**
 * Project-wide diagnostics: errors across every TS source under the same
 * tsconfig as `editedFilePath`, plus warnings on the edited file itself.
 *
 * Returns:
 *   - A formatted block when the project has at least one error/warning to
 *     show, or when the error count *dropped* since the last call (so the
 *     agent gets a positive "net change" signal even with zero errors).
 *   - undefined when there's nothing to say (no errors now, none last time,
 *     no warnings on the edited file, or the file isn't TS/JS).
 */
export function getDiagnosticsForProject(editedFilePath: string): string | undefined {
    const ext = path.extname(editedFilePath).toLowerCase();
    if (!TS_EXTS.has(ext)) return undefined;

    const editedAbs = path.resolve(editedFilePath);

    let project: IProject | undefined;
    try {
        project = loadProject(editedAbs);
    } catch {
        return undefined;
    }
    if (!project) return undefined;

    // Re-snapshot the just-edited file from disk so the LanguageService sees
    // the freshest version. Other files keep whatever snapshot/version they
    // already had (TS reads them lazily through the host's readFile).
    let editedExists = true;
    try {
        const content = fs.readFileSync(editedAbs, 'utf8');
        const v = (project.fileVersions.get(editedAbs) ?? 0) + 1;
        project.fileVersions.set(editedAbs, v);
        project.fileSnapshots.set(editedAbs, content);
        project.rootFiles.add(editedAbs);
        try {
            project.fileMtimes.set(editedAbs, fs.statSync(editedAbs).mtimeMs);
        } catch { /* mtime is best-effort */ }
    } catch {
        // File was deleted or is not readable — still useful to report
        // diagnostics for the rest of the project.
        editedExists = false;
    }

    // Detect out-of-band changes (files modified since the last diagnostics
    // run that we did NOT edit ourselves). Bump their versions so the TS
    // LanguageService invalidates its cached AST and re-parses from disk.
    // Without this, edits to a single file never cause its cross-file
    // dependents to be re-checked, and we report stale diagnostics for them.
    for (const rootFile of project.rootFiles) {
        if (rootFile === editedAbs) continue;
        let mtime: number;
        try {
            mtime = fs.statSync(rootFile).mtimeMs;
        } catch {
            continue;
        }
        const lastMtime = project.fileMtimes.get(rootFile);
        if (lastMtime === undefined) {
            // First time we observe this file — record mtime but don't bump.
            // The LanguageService will read it from disk on first request.
            project.fileMtimes.set(rootFile, mtime);
            continue;
        }
        if (mtime !== lastMtime) {
            project.fileMtimes.set(rootFile, mtime);
            // Drop any stale in-memory snapshot so getScriptSnapshot falls
            // through to a fresh disk read.
            project.fileSnapshots.delete(rootFile);
            const v = (project.fileVersions.get(rootFile) ?? 0) + 1;
            project.fileVersions.set(rootFile, v);
        }
    }

    const program = project.service.getProgram();
    if (!program) return undefined;

    const fileDiags = new Map<string, ts.Diagnostic[]>();
    let totalErrors = 0;
    let totalWarnings = 0;

    for (const sf of program.getSourceFiles()) {
        const abs = path.resolve(sf.fileName);
        if (!isCheckableProjectFile(abs, project.rootDir)) continue;

        const isEdited = abs === editedAbs;

        let diags: ts.Diagnostic[];
        try {
            diags = [
                ...project.service.getSyntacticDiagnostics(abs),
                ...project.service.getSemanticDiagnostics(abs),
            ];
        } catch {
            continue;
        }

        // Errors everywhere; warnings only on the edited file (otherwise stale
        // warnings in unrelated files would pollute every turn).
        const filtered = diags.filter((d) => {
            if (d.category === ts.DiagnosticCategory.Error) return true;
            if (isEdited && d.category === ts.DiagnosticCategory.Warning) return true;

            return false;
        });

        if (filtered.length === 0) continue;

        for (const d of filtered) {
            if (d.category === ts.DiagnosticCategory.Error) totalErrors++;
            else if (d.category === ts.DiagnosticCategory.Warning) totalWarnings++;
        }

        fileDiags.set(abs, filtered);
    }

    const previousErrors = project.lastErrorCount;
    project.lastErrorCount = totalErrors;

    const delta = previousErrors >= 0 ? totalErrors - previousErrors : null;

    if (fileDiags.size === 0) {
        // Positive feedback when the agent's edit cleared errors.
        if (delta !== null && delta < 0) {
            const fixed = Math.abs(delta);

            return `Diagnostics for project: 0 errors. (net change since last edit: -${fixed} error${fixed === 1 ? '' : 's'})`;
        }

        return undefined;
    }

    const orderedFiles = Array.from(fileDiags.keys()).sort((a, b) => {
        if (a === editedAbs && b !== editedAbs) return -1;
        if (b === editedAbs && a !== editedAbs) return 1;

        return a.localeCompare(b);
    });

    const headerCounts = [
        `${totalErrors} error${totalErrors === 1 ? '' : 's'}`,
        totalWarnings > 0 ? `${totalWarnings} warning${totalWarnings === 1 ? '' : 's'}` : null,
    ].filter(Boolean).join(', ');

    const lines: string[] = [`Diagnostics for project (${headerCounts}):`];

    let shown = 0;
    let truncated = 0;

    for (const f of orderedFiles) {
        const rel = path.relative(project.rootDir, f) || path.basename(f);
        const fileLines: string[] = [];

        for (const d of fileDiags.get(f)!) {
            if (shown >= MAX_PROJECT_DIAGNOSTICS) {
                truncated++;
                continue;
            }
            fileLines.push(`    ${formatDiagnosticBody(d)}`);
            shown++;
        }

        if (fileLines.length > 0) {
            lines.push(`  ${rel}:`);
            lines.push(...fileLines);
        }
    }

    if (truncated > 0) {
        const tsconfigArg = project.configPath
            ? ` -p ${path.relative(project.rootDir, project.configPath) || project.configPath}`
            : '';

        lines.push(`  ...and ${truncated} more — run \`npx tsc --noEmit${tsconfigArg}\` for the full list.`);
    }

    if (delta !== null && delta !== 0) {
        const sign = delta > 0 ? '+' : '';

        lines.push('');
        lines.push(`(net change since last edit: ${sign}${delta} error${Math.abs(delta) === 1 ? '' : 's'})`);
    }

    if (!editedExists) {
        lines.push('');
        lines.push(`(${path.relative(project.rootDir, editedAbs) || path.basename(editedAbs)} was not readable; reporting the rest of the project.)`);
    }

    return lines.join('\n');
}


export function getDiagnosticsForFile(filePath: string): string | undefined {
    const ext = path.extname(filePath).toLowerCase();
    if (!TS_EXTS.has(ext)) return undefined;

    const absPath = path.resolve(filePath);

    let project: IProject | undefined;
    try {
        project = loadProject(absPath);
    } catch {
        return undefined;
    }
    if (!project) return undefined;

    let content: string;
    try {
        content = fs.readFileSync(absPath, 'utf8');
    } catch {
        return undefined;
    }

    const v = (project.fileVersions.get(absPath) ?? 0) + 1;
    project.fileVersions.set(absPath, v);
    project.fileSnapshots.set(absPath, content);
    project.rootFiles.add(absPath);

    let diagnostics: ts.Diagnostic[];
    try {
        diagnostics = [
            ...project.service.getSyntacticDiagnostics(absPath),
            ...project.service.getSemanticDiagnostics(absPath),
        ];
    } catch {
        return undefined;
    }

    // Filter out anything below warning so suggestions/messages don't pollute.
    const filtered = diagnostics.filter(
        (d) => d.category === ts.DiagnosticCategory.Error || d.category === ts.DiagnosticCategory.Warning
    );

    if (filtered.length === 0) return undefined;

    const shown = filtered.slice(0, MAX_DIAGNOSTICS).map(formatDiagnostic);
    const more = filtered.length > MAX_DIAGNOSTICS
        ? `\n  ...and ${filtered.length - MAX_DIAGNOSTICS} more`
        : '';

    return `Diagnostics for ${path.relative(project.rootDir, absPath) || path.basename(absPath)} (${filtered.length}):\n${shown.join('\n')}${more}`;
}
