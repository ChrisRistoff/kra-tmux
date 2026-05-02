import blessed from 'blessed';
import {
    attachFocusCycleKeys,
    awaitScreenDestroy,
    createDashboardFooter,
    createDashboardHeader,
    createDashboardScreen,
    createFocusRing,
    type FocusRing,
} from '@/UI/dashboard';
import { mountFindingsRevisitsSection, type MemorySectionHandle } from './sections/findingsRevisits';
import { mountIndexedReposSection } from './sections/indexedRepos';
import { mountDocsSourcesSection } from './sections/docsSources';
import { mountSearchSection } from './sections/search';

type SectionFactory = (opts: {
    screen: blessed.Widgets.Screen;
    parent: blessed.Widgets.BoxElement;
    setStatus: (text: string) => void;
}) => MemorySectionHandle;

const TAB_LABELS = ['1 Findings/Revisits', '2 Indexed repos', '3 Docs sources', '4 Search'] as const;
const SECTION_NAMES = ['findings/revisits', 'indexed repos', 'docs sources', 'search'] as const;

export async function memoryDashboard(): Promise<void> {
    const screen = createDashboardScreen({ title: 'kra memory' });

    const header = createDashboardHeader(screen);

    const keymap = createDashboardFooter(screen);

    const content = blessed.box({
        parent: screen,
        top: 3,
        bottom: 3,
        left: 0,
        right: 0,
    });

    const sections: SectionFactory[] = [
        mountFindingsRevisitsSection,
        mountIndexedReposSection,
        mountDocsSourcesSection,
        mountSearchSection,
    ];

    let activeIndex = 0;
    let activeHandle: MemorySectionHandle | null = null;
    let currentRing: FocusRing | null = null;

    function quit(): void {
        activeHandle?.destroy();
        try { screen.destroy(); } catch { /* noop */ }
    }

    function setStatus(_sectionKeys: string): void {
        currentRing?.renderFooter();
        screen.render();
    }

    function renderHeader(): void {
        const tabs = TAB_LABELS.map((label, idx) => idx === activeIndex
            ? `{yellow-fg}{bold}${label}{/bold}{/yellow-fg}`
            : `{gray-fg}${label}{/gray-fg}`)
            .join('   ');
        header.setContent(
            ` {magenta-fg}{bold}◆ kra memory{/bold}{/magenta-fg}   {cyan-fg}section{/cyan-fg} {yellow-fg}${SECTION_NAMES[activeIndex]}{/yellow-fg}   ${tabs}`,
        );
    }

    function mountSection(idx: number): void {
        activeHandle?.destroy();
        content.children.slice().forEach((child) => child.destroy());
        activeIndex = idx;
        renderHeader();
        activeHandle = sections[idx]({ screen, parent: content, setStatus });
        const ring = createFocusRing({
            screen,
            panels: activeHandle.panels.length > 0
                ? activeHandle.panels
                : [{ el: content as blessed.Widgets.BlessedElement, name: 'content', color: 'cyan' }],
            footer: keymap,
            keymapText: () => `{cyan-fg}1-4{/cyan-fg} section   {cyan-fg}Tab{/cyan-fg} cycle   {cyan-fg}q/C-c{/cyan-fg} quit   ${activeHandle?.keymap() ?? ''}`,
        });
        currentRing = ring;
        if (typeof (screen as unknown as { unkey?: (keys: string[]) => void }).unkey === 'function') {
            (screen as unknown as { unkey: (keys: string[]) => void }).unkey(['tab', 'S-tab']);
        }
        attachFocusCycleKeys(screen, ring);
        ring.focusAt(0);
        ring.renderFooter();
        screen.render();
    }

    screen.key(['1'], () => mountSection(0));
    screen.key(['2'], () => mountSection(1));
    screen.key(['3'], () => mountSection(2));
    screen.key(['4'], () => mountSection(3));
    screen.key(['q', 'C-c'], quit);

    mountSection(0);
    await awaitScreenDestroy(screen);
}
