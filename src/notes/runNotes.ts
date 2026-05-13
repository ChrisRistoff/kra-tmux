import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { notesRoot } from '@/filePaths';
import { notesNvimInitLuaPath } from '@/packagePaths';

function ensureNotesRoot(): void {
    if (!fs.existsSync(notesRoot)) {
        fs.mkdirSync(notesRoot, { recursive: true });
    }
}

/**
 * If we're inside tmux and not already inside a kra-notes popup, re-launch
 * ourselves through `tmux display-popup` so notes always opens as an overlay
 * (even if invoked from a regular pane that's running nvim, etc).
 * Returns true if we handed off; the caller should bail out.
 */
function popupIfNeeded(extraArgs: string[]): boolean {
    if (!process.env.TMUX) return false;
    if (process.env.KRA_NOTES_INNER === '1') return false;

    const argv = ['kra', 'notes', ...extraArgs];
    const quoted = argv.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
    const proc = spawn(
        'tmux',
        ['display-popup', '-E', '-w', '90%', '-h', '90%', '-T', ' kra notes ', `KRA_NOTES_INNER=1 ${quoted}`],
        { stdio: 'inherit', shell: false },
    );
    proc.on('error', () => { /* fall through; caller already returned */ });

    return true;
}

function resolveNoteName(rawName: string): string {
    let name = rawName.trim();
    if (!name) name = 'index';
    name = name.replace(/^[/\\]+/, '');
    if (path.isAbsolute(name)) {
        return name.endsWith('.md') ? name : `${name}.md`;
    }
    if (!name.endsWith('.md')) name = `${name}.md`;
    const abs = path.resolve(notesRoot, name);
    const rel = path.relative(notesRoot, abs);
    if (rel.startsWith('..')) {
        throw new Error(`note name '${rawName}' resolves outside notes root`);
    }

    return abs;
}

async function spawnNvim(filePath: string | null): Promise<void> {
    const args = ['-u', notesNvimInitLuaPath];
    if (filePath) {
        args.push(filePath);
    } else {
        // No specific file requested — launch the Telescope picker.
        args.push('+KraNotesPicker');
    }

    const dataDir = path.join(notesRoot, '.nvim-data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const env = {
        ...process.env,
        XDG_DATA_HOME: path.join(dataDir, 'share'),
        XDG_STATE_HOME: path.join(dataDir, 'state'),
        XDG_CACHE_HOME: path.join(dataDir, 'cache'),
        XDG_CONFIG_HOME: path.join(dataDir, 'config'),
    };

    return new Promise((resolve, reject) => {
        const proc = spawn('nvim', args, { stdio: 'inherit', shell: false, env });
        proc.on('close', (code) => {
            if (code === 0 || code === null) return resolve();
            reject(new Error(`nvim exited with code ${code}`));
        });
        proc.on('error', (err) => {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                reject(new Error('nvim not found in PATH. Please install Neovim.'));
            } else {
                reject(err);
            }
        });
    });
}

export async function openNote(args: string[] = []): Promise<void> {
    ensureNotesRoot();
    if (popupIfNeeded(args)) return;
    const name = args[0];
    if (!name) {
        await spawnNvim(null);

        return;
    }
    const filePath = resolveNoteName(name);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    await spawnNvim(filePath);
}

export async function newNote(args: string[] = []): Promise<void> {
    ensureNotesRoot();
    if (popupIfNeeded(['new', ...args])) return;
    const name = args[0];
    if (!name) {
        throw new Error('usage: kra notes new <name>');
    }
    const filePath = resolveNoteName(name);
    if (fs.existsSync(filePath)) {
        throw new Error(`note already exists: ${path.relative(notesRoot, filePath)}`);
    }
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const title = path.basename(filePath, '.md').replace(/[-_]/g, ' ');
    const date = new Date().toISOString().slice(0, 10);
    const seed = `---\ncreated: ${date}\ntags: []\n---\n\n# ${title}\n\n`;
    fs.writeFileSync(filePath, seed, 'utf8');
    await spawnNvim(filePath);
}

export async function pickNote(_args: string[] = []): Promise<void> {
    ensureNotesRoot();
    if (popupIfNeeded(['pick'])) return;
    await spawnNvim(null);
}

export async function journalNote(args: string[] = []): Promise<void> {
    ensureNotesRoot();
    if (popupIfNeeded(['journal', ...args])) return;
    const when = (args[0] || 'today').trim();
    const date = resolveJournalDate(when);
    const yyyy = String(date.getFullYear());
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const iso = `${yyyy}-${mm}-${dd}`;
    const filePath = path.join(notesRoot, 'journal', yyyy, mm, `${iso}.md`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) {
        const nice = date.toDateString();
        const seed = `---\ncreated: ${iso}\ntags: [journal]\n---\n\n# ${nice}\n\n## Notes\n\n## Tasks\n\n- [ ] \n`;
        fs.writeFileSync(filePath, seed, 'utf8');
    }
    await spawnNvim(filePath);
}

function resolveJournalDate(when: string): Date {
    const now = new Date();
    if (!when || when === 'today') return now;
    if (when === 'yesterday') return new Date(now.getTime() - 86400 * 1000);
    if (when === 'tomorrow') return new Date(now.getTime() + 86400 * 1000);
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(when);
    if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), 12);
    throw new Error(`unrecognized journal date: ${when} (use today|yesterday|tomorrow|YYYY-MM-DD)`);
}
