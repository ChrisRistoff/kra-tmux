import blessed from 'blessed';
import { spawn } from 'child_process';
import { loadSettings } from '@/utils/common';
import { semanticSearch } from '@/AI/AIAgent/shared/memory/search';
import type { SemanticSearchHit } from '@/AI/AIAgent/shared/memory/types';
import { docsSearch, type DocsSearchHit } from '@/AI/AIAgent/shared/docs/search';
import {
    attachVerticalNavigation,
    createDashboardList,
    createDashboardSearchBox,
    createDashboardTextPanel,
    escTag,
} from '@/UI/dashboard';
import { runInherit } from '@/UI/dashboard/screen';
import type { MemorySectionHandle } from './findingsRevisits';

type ScopeKey = 'code' | 'memory-findings' | 'memory-revisits' | 'docs';

interface SearchResult {
    kind: 'code' | 'memory' | 'docs';
    score: number;
    code?: SemanticSearchHit;
    memory?: SemanticSearchHit;
    docs?: DocsSearchHit;
}

const ALL_SCOPES: ScopeKey[] = ['code', 'memory-findings', 'memory-revisits', 'docs'];
const SCOPE_LABELS: Record<ScopeKey, string> = {
    code: 'Code',
    'memory-findings': 'Memory(findings)',
    'memory-revisits': 'Memory(revisits)',
    docs: 'Docs',
};

export function mountSearchSection(opts: {
    screen: blessed.Widgets.Screen;
    parent: blessed.Widgets.BoxElement;
    setStatus: (text: string) => void;
}): MemorySectionHandle {
    const { screen, parent, setStatus } = opts;

    const input = createDashboardSearchBox(parent, {
        label: 'query (s / / to focus)',
        top: 0,
        left: 0,
        right: 0,
        height: 3,
        borderColor: 'magenta',
        inputOnFocus: true,
    });

    const results = createDashboardList(parent, {
        label: 'results',
        top: 3,
        left: 0,
        width: '50%',
        bottom: 0,
        tags: true,
        keys: false,
        vi: false,
        mouse: true,
    });

    const detail = createDashboardTextPanel(parent, {
        label: 'detail',
        top: 3,
        left: '50%',
        right: 0,
        bottom: 0,
        borderColor: 'yellow',
        tags: true,
    });

    let selectedScopes = new Set<ScopeKey>(ALL_SCOPES);
    let docsAliases: string[] = [];
    let resultsState: SearchResult[] = [];

    function scopeLabel(): string {
        if (selectedScopes.size === ALL_SCOPES.length) return 'All';
        if (selectedScopes.size === 0) return 'None';

        return ALL_SCOPES.filter((s) => selectedScopes.has(s)).map((s) => SCOPE_LABELS[s]).join('+');
    }

    function setInputLabel(): void {
        input.setLabel(' query (s / / to focus) ');
    }

    function keymapText(): string {
        return `{cyan-fg}s//{/cyan-fg} query   {cyan-fg}Enter{/cyan-fg} run/open   {cyan-fg}j/k{/cyan-fg} nav   `
            + `{cyan-fg}f{/cyan-fg} scopes   {cyan-fg}o{/cyan-fg} open URL   {cyan-fg}y{/cyan-fg} copy   `
            + `{gray-fg}scope: ${scopeLabel()}${docsAliases.length > 0 ? `   docs=${docsAliases.join(',')}` : ''}{/gray-fg}`;
    }

    function setIdleStatus(): void {
        setInputLabel();
        setStatus(keymapText());
        screen.render();
    }

    function renderItem(row: SearchResult): string {
        const score = row.score.toFixed(3);
        if (row.kind === 'code' && row.code) {
            const c = row.code.code!;
            const first = c.startLines[0] ?? 1;
            const last = c.endLines[0] ?? first;

            return `{cyan-fg}[code]{/cyan-fg} ${escTag(c.path)} L${first}-${last} {gray-fg}(${score}){/gray-fg}`;
        }
        if (row.kind === 'memory' && row.memory) {
            const m = row.memory.memory!;

            return `{magenta-fg}[${m.kind}]{/magenta-fg} ${escTag(m.title)} {gray-fg}(${score}){/gray-fg}`;
        }
        if (row.kind === 'docs' && row.docs) {
            const d = row.docs;

            return `{yellow-fg}[${d.sourceAlias}]{/yellow-fg} ${escTag(d.pageTitle ?? d.url)} {gray-fg}(${score}){/gray-fg}`;
        }

        return '';
    }

    function selectedResult(): SearchResult | undefined {
        const idx = (results as unknown as { selected: number }).selected || 0;

        return resultsState[idx];
    }

    function moveResultsBy(delta: number): void {
        if (resultsState.length === 0) return;
        const current = (results as unknown as { selected?: number }).selected ?? 0;
        const next = Math.max(0, Math.min(resultsState.length - 1, current + delta));
        results.select(next);
        renderDetail(selectedResult());
        screen.render();
    }

    function renderDetail(row?: SearchResult): void {
        if (!row) {
            detail.setContent('{gray-fg}No selection.{/gray-fg}');
        } else if (row.kind === 'code' && row.code) {
            const c = row.code.code!;
            const ranges = c.startLines.map((start, idx) => `  - L${start}-${c.endLines[idx] ?? start}`).join('\n');
            detail.setContent([
                `{cyan-fg}path{/cyan-fg}  ${escTag(c.path)}`,
                `{cyan-fg}score{/cyan-fg} ${row.score.toFixed(4)}`,
                '',
                `{cyan-fg}matched line ranges:{/cyan-fg}`,
                ranges || '  (none)',
                '',
                '{gray-fg}Press enter to open in $EDITOR.{/gray-fg}',
            ].join('\n'));
        } else if (row.kind === 'memory' && row.memory) {
            const m = row.memory.memory!;
            detail.setContent([
                `{magenta-fg}[${m.kind}]{/magenta-fg} {bold}${escTag(m.title)}{/bold}`,
                `{cyan-fg}score{/cyan-fg} ${row.score.toFixed(4)}`,
                m.status ? `{cyan-fg}status{/cyan-fg} ${m.status}` : '',
                m.tags && m.tags.length > 0 ? `{cyan-fg}tags{/cyan-fg} ${m.tags.join(', ')}` : '',
                m.paths && m.paths.length > 0 ? `{cyan-fg}paths{/cyan-fg} ${m.paths.join(', ')}` : '',
                '',
                escTag(m.body),
            ].filter(Boolean).join('\n'));
        } else if (row.kind === 'docs' && row.docs) {
            const d = row.docs;
            detail.setContent([
                `{yellow-fg}[${d.sourceAlias}]{/yellow-fg} {bold}${escTag(d.pageTitle ?? d.url)}{/bold}`,
                `{cyan-fg}url{/cyan-fg} ${escTag(d.url)}`,
                `{cyan-fg}score{/cyan-fg} ${row.score.toFixed(4)}`,
                '',
                ...d.sections.flatMap((section) => [
                    `{magenta-fg}# ${escTag(section.sectionPath)}{/magenta-fg} {gray-fg}(${section.score.toFixed(3)}){/gray-fg}`,
                    escTag(section.content),
                    '',
                ]),
                '{gray-fg}Press o to open URL in browser{/gray-fg}',
            ].join('\n'));
        }

        detail.setScrollPerc(0);
        screen.render();
    }

    async function pickScopes(): Promise<void> {
        const next = await modalMultiChoice(
            screen,
            'select scopes (space toggle, enter confirm)',
            ALL_SCOPES.map((s) => ({ key: s, label: SCOPE_LABELS[s] })),
            selectedScopes,
        );
        if (!next) return;
        if (next.size === 0) {
            setStatus('{yellow-fg}select at least one scope{/yellow-fg}');

            return;
        }
        selectedScopes = next as Set<ScopeKey>;
        setIdleStatus();
        results.focus();
        screen.render();
    }

    async function runSearch(): Promise<void> {
        const query = input.getValue().trim();
        if (!query) {
            setStatus('{yellow-fg}search: query is required{/yellow-fg}');

            return;
        }

        setStatus(`{yellow-fg}searching ${scopeLabel()}...{/yellow-fg}`);
        resultsState = [];
        results.setItems([]);
        renderDetail(undefined);
        screen.render();

        try {
            const tasks: Promise<SearchResult[]>[] = [];
            if (selectedScopes.has('code')) {
                tasks.push(
                    semanticSearch({ query, scope: 'code', k: 30 })
                        .then((hits) => hits.map((hit) => ({ kind: hit.type, score: hit.score, code: hit } as SearchResult))),
                );
            }
            if (selectedScopes.has('memory-findings')) {
                tasks.push(
                    semanticSearch({ query, scope: 'memory', memoryKind: 'findings', k: 30 })
                        .then((hits) => hits.map((hit) => ({ kind: 'memory', score: hit.score, memory: hit } as SearchResult))),
                );
            }
            if (selectedScopes.has('memory-revisits')) {
                tasks.push(
                    semanticSearch({ query, scope: 'memory', memoryKind: 'revisit', k: 30 })
                        .then((hits) => hits.map((hit) => ({ kind: 'memory', score: hit.score, memory: hit } as SearchResult))),
                );
            }
            if (selectedScopes.has('docs')) {
                tasks.push(
                    docsSearch({ query, k: 30 })
                        .then((hits) => hits.map((hit) => ({ kind: 'docs', score: hit.score, docs: hit } as SearchResult))),
                );
            }
            const groups = await Promise.all(tasks);
            resultsState = groups.flat().sort((a, b) => b.score - a.score);

            results.setItems(resultsState.map(renderItem));
            results.select(0);
            renderDetail(resultsState[0]);
            setStatus(`{green-fg}${resultsState.length} result(s) for ${scopeLabel()}{/green-fg}`);
        } catch (err) {
            setStatus(`{red-fg}search failed: ${escTag(err instanceof Error ? err.message : String(err))}{/red-fg}`);
        }

        screen.render();
    }

    async function openCodeResult(row: SearchResult): Promise<void> {
        const hit = row.code?.code;
        if (!hit) return;

        const firstLine = hit.startLines[0] ?? 1;
        const editorRaw = process.env.EDITOR?.trim() || 'nvim';
        const [cmd, ...baseArgs] = editorRaw.split(/\s+/).filter(Boolean);
        await runInherit(cmd, [...baseArgs, `+${firstLine}`, hit.path], screen);
        renderDetail(row);
    }

    function openUrl(url: string): void {
        const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
        const p = spawn(cmd, [url], { stdio: 'ignore', detached: true });
        p.unref();
    }

    function copyText(text: string): boolean {
        let cmd: string | null = null;
        let args: string[] = [];

        if (process.platform === 'darwin') {
            cmd = 'pbcopy';
        } else if (process.env.WAYLAND_DISPLAY) {
            cmd = 'wl-copy';
        } else if (process.env.DISPLAY) {
            cmd = 'xclip';
            args = ['-selection', 'clipboard'];
        }

        if (!cmd) return false;

        try {
            const p = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
            p.stdin.write(text);
            p.stdin.end();

            return true;
        } catch {
            return false;
        }
    }

    results.on('select item', () => {
        renderDetail(selectedResult());
    });

    results.key(['enter'], async () => {
        const row = selectedResult();
        if (!row) return;
        if (row.kind === 'code') {
            await openCodeResult(row);
        } else {
            renderDetail(row);
        }
        results.focus();
    });

    input.key(['enter'], async () => {
        await runSearch();
        results.focus();
    });

    input.key(['escape'], () => {
        input.clearValue();
        resultsState = [];
        results.setItems([]);
        renderDetail(undefined);
        setIdleStatus();
        screen.render();
    });


    attachVerticalNavigation(results as unknown as blessed.Widgets.BlessedElement & {
        key: (keys: string[] | string, handler: () => void) => unknown;
    }, {
        moveBy: moveResultsBy,
        top: () => {
            if (resultsState.length === 0) return;
            results.select(0);
            renderDetail(selectedResult());
            screen.render();
        },
        bottom: () => {
            if (resultsState.length === 0) return;
            results.select(resultsState.length - 1);
            renderDetail(selectedResult());
            screen.render();
        },
    });

    const focusInput = () => { input.focus(); input.readInput(); };
    results.key(['s', '/'], focusInput);
    detail.key(['s', '/'], focusInput);
    results.key(['f'], () => { void pickScopes(); });
    detail.key(['f'], () => { void pickScopes(); });

    screen.key(['o'], () => {
        const row = selectedResult();
        if (row?.kind === 'docs' && row.docs) {
            openUrl(row.docs.url);
            setStatus(`{green-fg}opened ${escTag(row.docs.url)}{/green-fg}`);
        }
    });

    screen.key(['y'], () => {
        const row = selectedResult();
        if (!row) return;
        const value = row.kind === 'code'
            ? (row.code?.code?.path ?? '')
            : row.kind === 'docs'
                ? (row.docs?.url ?? '')
                : (row.memory?.memory?.title ?? '');
        if (!value) return;
        const ok = copyText(value);
        setStatus(ok
            ? `{green-fg}copied: ${escTag(value)}{/green-fg}`
            : `{yellow-fg}copy unavailable on this platform{/yellow-fg}`);
    });

    void loadSettings().then((settings) => {
        docsAliases = (settings.ai?.docs?.sources ?? []).map((source) => source.alias);
        setIdleStatus();
    });

    setIdleStatus();

    return {
        destroy: () => {
            try { input.destroy(); } catch { /* noop */ }
            try { results.destroy(); } catch { /* noop */ }
            try { detail.destroy(); } catch { /* noop */ }
        },
        focus: () => results.focus(),
        panels: [
            { el: results, name: 'results', color: 'cyan' },
            { el: detail, name: 'detail', color: 'yellow' },
        ],
        keymap: keymapText,
    };
}

async function modalMultiChoice(
    screen: blessed.Widgets.Screen,
    label: string,
    items: { key: string; label: string }[],
    initial: Set<string>,
): Promise<Set<string> | null> {
    return new Promise((resolve) => {
        const selected = new Set(initial);
        const modal = blessed.box({
            parent: screen,
            label: ` ${label} `,
            top: 'center',
            left: 'center',
            width: '50%',
            height: Math.min(items.length + 7, 24),
            border: { type: 'line' },
            tags: true,
            style: {
                border: { fg: 'magenta' },
                bg: 'black',
            },
        });
        const list = blessed.list({
            parent: modal,
            top: 1,
            left: 1,
            right: 1,
            bottom: 3,
            keys: false,
            vi: false,
            mouse: true,
            tags: true,
            style: {
                selected: { bg: 'magenta', fg: 'white', bold: true },
                item: { fg: 'white', bg: 'black' },
                fg: 'white',
                bg: 'black',
            },
            items: render(),
        });
        list.removeAllListeners('select');
        list.removeAllListeners('action');

        const help = blessed.box({
            parent: modal,
            left: 1,
            right: 1,
            bottom: 1,
            height: 1,
            tags: true,
            content: '{gray-fg}space toggle · enter confirm · q/esc cancel{/gray-fg}',
        });

        function render(): string[] {
            return items.map((it) => {
                const mark = selected.has(it.key) ? '{green-fg}[x]{/green-fg}' : '[ ]';

                return `${mark} ${it.label}`;
            });
        }

        function refresh(): void {
            const idx = (list as unknown as { selected: number }).selected || 0;
            list.setItems(render());
            list.select(Math.max(0, Math.min(items.length - 1, idx)));
            screen.render();
        }

        const cleanup = (val: Set<string> | null): void => {
            try { help.destroy(); } catch { /* noop */ }
            modal.destroy();
            screen.render();
            resolve(val);
        };

        const move = (delta: number) => {
            const cur = (list as unknown as { selected: number }).selected ?? 0;
            const next = Math.max(0, Math.min(items.length - 1, cur + delta));
            list.select(next);
            screen.render();
        };
        list.key(['j', 'down'], () => move(1));
        list.key(['k', 'up'], () => move(-1));
        list.key(['g'], () => { list.select(0); screen.render(); });
        list.key(['G'], () => { list.select(items.length - 1); screen.render(); });

        list.key(['space'], () => {
            const idx = (list as unknown as { selected: number }).selected || 0;
            const it = items[idx];
            if (!it) return;
            if (selected.has(it.key)) selected.delete(it.key);
            else selected.add(it.key);
            list.setItems(render());
            list.select(idx);
            screen.render();
        });
        list.key(['a'], () => {
            for (const it of items) selected.add(it.key);
            refresh();
        });
        list.key(['n'], () => {
            selected.clear();
            refresh();
        });
        list.key(['escape', 'q'], () => cleanup(null));
        list.key(['enter'], () => cleanup(selected));
        list.focus();
        screen.render();
    });
}

