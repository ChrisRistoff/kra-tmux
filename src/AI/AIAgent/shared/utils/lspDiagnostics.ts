/**
 * Lightweight TypeScript diagnostics for the agent's edit/create tools.
 *
 * Uses the in-process TypeScript Compiler API (already a dep) instead of
 * spawning typescript-language-server — no JSON-RPC, no extra binary, and
 * we share the LanguageService across edits in the same session so warm
 * checks are sub-second.
 *
 * Public entry point: getDiagnosticsForFile(filePath) — returns a formatted
 * string of errors+warnings for that single file, or undefined if there are
 * none, the file is not a TS/JS source, or the project couldn't be loaded.
 *
 * The MCP server appends the result to edit_lines / create_file responses so
 * the agent sees type errors in the same turn it made the change.
 */

import * as ts from 'typescript';
import * as path from 'path';
import * as fs from 'fs';

const TS_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

const MAX_DIAGNOSTICS = 20;

interface IProject {
    rootDir: string;
    compilerOptions: ts.CompilerOptions;
    rootFiles: Set<string>;
    fileVersions: Map<string, number>;
    fileSnapshots: Map<string, string>;
    service: ts.LanguageService;
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
        compilerOptions,
        rootFiles,
        fileVersions: new Map(),
        fileSnapshots: new Map(),
        // Set after host construction below.
        service: null as unknown as ts.LanguageService,
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

function formatDiagnostic(d: ts.Diagnostic): string {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n  ');
    const sev = d.category === ts.DiagnosticCategory.Error ? 'error' : 'warning';
    if (d.file && d.start !== undefined) {
        const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);

        return `  L${line + 1}:${character + 1}  ${sev} TS${d.code}: ${msg}`;
    }

    return `  ${sev} TS${d.code}: ${msg}`;
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
