/**
 * Programmatic installer for the Crawl4AI Python venv used by the docs
 * pipeline. Called from `manageDocs()` (the interactive `kra ai docs` menu).
 * The user-facing disk-usage prompt lives in `manageDocs`; this function
 * just does the work and returns a structured result.
 *
 * Disk usage: ~507 MB total under `~/.kra/crawl4ai-venv/` (Python deps
 * ≈ 318 MB, headless Chromium ≈ 189 MB).
 */

import fs from 'fs';
import { spawn, execSync } from 'child_process';

import {
    crawl4aiVenvDir,
    crawl4aiVenvPython,
    crawl4aiInstalledMarker,
} from '@/filePaths';
import { docsPythonRequirementsPath } from '@/packagePaths';

export type InstallCrawl4aiOptions = {
    force?: boolean,
};

export type InstallCrawl4aiResult =
    | { kind: 'already-installed', venvDir: string }
    | { kind: 'installed', venvDir: string }
    | { kind: 'error', message: string };

function run(cmd: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: 'inherit', env: process.env });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
        });
    });
}

function findHostPython(): string | null {
    const candidates = ['python3.12', 'python3.11', 'python3.13', 'python3.10', 'python3'];
    for (const candidate of candidates) {
        try {
            execSync(`${candidate} --version`, { stdio: 'ignore' });
            return candidate;
        } catch { /* try next */ }
    }
    return null;
}

export function isCrawl4aiInstalled(): boolean {
    return fs.existsSync(crawl4aiInstalledMarker);
}

export async function installCrawl4ai(opts: InstallCrawl4aiOptions = {}): Promise<InstallCrawl4aiResult> {
    const force = opts.force === true;

    if (isCrawl4aiInstalled() && !force) {
        return { kind: 'already-installed', venvDir: crawl4aiVenvDir };
    }

    if (!fs.existsSync(docsPythonRequirementsPath)) {
        return {
            kind: 'error',
            message: `requirements file not found at ${docsPythonRequirementsPath} (broken kra-workflow install)`,
        };
    }

    const hostPython = findHostPython();
    if (!hostPython) {
        return {
            kind: 'error',
            message: 'no python3 interpreter found on PATH (install Python 3.10+)',
        };
    }

    try {
        if (!fs.existsSync(crawl4aiVenvPython) || force) {
            console.log(`kra-docs: creating venv with ${hostPython} -m venv ${crawl4aiVenvDir}`);
            await run(hostPython, ['-m', 'venv', crawl4aiVenvDir]);
        }

        console.log('kra-docs: upgrading pip in venv…');
        await run(crawl4aiVenvPython, ['-m', 'pip', 'install', '--upgrade', 'pip']);

        console.log('kra-docs: installing Crawl4AI (resolving full dependency tree)…');
        await run(crawl4aiVenvPython, ['-m', 'pip', 'install', '-r', docsPythonRequirementsPath]);


        const heavyOptional = [
            'unclecode-litellm', 'litellm', 'openai',
            'patchright', 'tf-playwright-stealth', 'playwright-stealth',
            'alphashape', 'shapely', 'scipy', 'networkx',
        ];
        console.log(`kra-docs: pruning ${heavyOptional.length} heavy optional packages to keep the venv lean…`);
        try {
            await run(crawl4aiVenvPython, ['-m', 'pip', 'uninstall', '-y', ...heavyOptional]);
        } catch { /* non-fatal */ }

        console.log('kra-docs: installing chromium headless-shell via playwright…');
        try {
            await run(crawl4aiVenvPython, ['-m', 'playwright', 'install', 'chromium-headless-shell']);
        } catch (err) {
            console.warn('kra-docs: chromium-headless-shell install failed; falling back to full chromium.', err);
            await run(crawl4aiVenvPython, ['-m', 'playwright', 'install', 'chromium']);
        }

        fs.writeFileSync(crawl4aiInstalledMarker, JSON.stringify({
            installedAt: Date.now(),
            pythonVersion: hostPython,
        }, null, 2));

        return { kind: 'installed', venvDir: crawl4aiVenvDir };
    } catch (err) {
        return { kind: 'error', message: (err as Error).message };
    }
}

