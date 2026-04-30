import { SearchOptions } from '@/types/uiTypes';
import {
    awaitScreenDestroy,
    createDashboardFooter,
    createDashboardHeader,
    createDashboardScreen,
    createDashboardTextPanel,
    escTag,
    setCenteredContent,
} from '@/UI/dashboard';
import { UserCancelled } from '@/UI/menuChain';
function uniqueStrings(items: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of items) {
        if (!seen.has(s)) {
            seen.add(s);
            out.push(s);
        }
    }

    return out;
}
function renderDefaultPickerDetails(
    prompt: string,
    header: string | undefined,
    items: string[],
    item: string,
    index: number,
): string {
    if (item === '<no items>' || item === '<no matches>') {
        return '{gray-fg}No selectable items for this menu.{/gray-fg}';
    }

    const total = items.filter((entry) => entry !== '<no items>' && entry !== '<no matches>').length;
    const headerLine = header && header !== prompt
        ? `{cyan-fg}context{/cyan-fg}   {white-fg}${escTag(header)}{/white-fg}`
        : null;

    return [
        `{cyan-fg}selected{/cyan-fg}  {bold}${escTag(item)}{/bold}`,
        `{cyan-fg}position{/cyan-fg}  {yellow-fg}${index + 1}{/yellow-fg} / {white-fg}${total}{/white-fg}`,
        `{cyan-fg}menu{/cyan-fg}      {white-fg}${escTag(prompt)}{/white-fg}`,
        ...(headerLine ? [headerLine] : []),
        '',
        '{gray-fg}enter{/gray-fg} choose item',
        '{gray-fg}s{/gray-fg} / {gray-fg}/{/gray-fg} search',
        '{gray-fg}q{/gray-fg} cancel',
    ].join('\n');
}

/**
 * Read-only info screen. Displays `content` in a scrollable, vim-keyed box.
 */
export async function showInfoScreen(title: string, content: string): Promise<void> {
    const screen = createDashboardScreen({ title });

    createDashboardHeader(screen, {
        content: `{center}{bold}${title}{/bold}{/center}`,
    });

    const body = createDashboardTextPanel(screen, {
        label: 'details',
        top: 3,
        left: 0,
        right: 0,
        bottom: 3,
        borderColor: 'yellow',
        scrollbarColor: 'cyan',
        content,
        tags: false,
    });

    const footer = createDashboardFooter(screen);
    setCenteredContent(footer, '↑/↓ scroll · g/G top/bottom · esc/q back');

    screen.key(['escape', 'q', 'C-c'], () => {
        try { screen.destroy(); } catch { /* noop */ }
    });

    body.focus();
    screen.render();

    await awaitScreenDestroy(screen);
}

/**
 * Yes / No Prompt
 */
export async function promptUserYesOrNo(message: string): Promise<boolean> {
    const { confirmDashboard } = await import('@/UI/dashboard/pickList');

    return confirmDashboard({
        title: 'Confirm',
        prompt: message,
    });
}

/**
 * Ask User For Free Text
 */

export async function askUserForInput(message: string): Promise<string> {
    const { inputDashboard } = await import('@/UI/dashboard/pickList');
    const value = await inputDashboard({
        title: 'Input',
        prompt: message,
    });

    if (value === null) throw new UserCancelled();

    return value;
}

/**
 * Search + Select (with type vs selection confirm)
 */
export async function searchAndSelect(options: SearchOptions): Promise<string> {
    const { pickList } = await import('@/UI/dashboard/pickList');

    let items = uniqueStrings(options.itemsArray);
    if (!items.length) items = ['<no items>'];

    const details = options.details ?? ((item: string, index: number) => renderDefaultPickerDetails(options.prompt, options.header, items, item, index));
    const detailsOptions = options.detailsUseTags !== undefined
        ? { detailsUseTags: options.detailsUseTags }
        : !options.details
            ? { detailsUseTags: true }
            : {};
    const result = await pickList({
        title: options.prompt,
        header: options.header ?? options.prompt,
        items,
        details,
        ...detailsOptions,
        ...(options.selected ? { selected: options.selected } : {}),
        ...(options.showDetailsPanel !== undefined ? { showDetailsPanel: options.showDetailsPanel } : {}),
        ...(options.pageSize ? { pageSize: options.pageSize } : {}),
        submitSearchQuery: true,
        footerChips:
            '↑/↓ navigate · enter select · s// search · enter(search) typed/select · [/] ±10 · {/} ±100 · q cancel',
    });

    if (result.value === null && result.action !== 'search-submit') {
        throw new UserCancelled();
    }

    const typedValue = result.query?.trim() ?? '';
    const selectedValue = result.value && result.value !== '<no items>' && result.value !== '<no matches>'
        ? result.value
        : '';

    if (result.action === 'search-submit') {
        if (typedValue && selectedValue && typedValue !== selectedValue) {
            const useTyped = await promptUserYesOrNo(
                `Use typed value "${typedValue}" instead of selected "${selectedValue}"?`,
            );

            return useTyped ? typedValue : selectedValue;
        }
        if (typedValue) {
            return typedValue;
        }
        if (selectedValue) {
            return selectedValue;
        }

        return '';
    }

    return selectedValue;
}

/**
 * Search + Select (simple: always return list selection)
 */
export async function searchSelectAndReturnFromArray(
    options: SearchOptions
): Promise<string> {
    const { pickList } = await import('@/UI/dashboard/pickList');
    const details = options.details ?? ((item: string, index: number) => renderDefaultPickerDetails(options.prompt, options.header, options.itemsArray, item, index));
    const detailsOptions = options.detailsUseTags !== undefined
        ? { detailsUseTags: options.detailsUseTags }
        : !options.details
            ? { detailsUseTags: true }
            : {};
    const result = await pickList({
        title: options.prompt,
        header: options.header ?? options.prompt,
        items: options.itemsArray,
        details,
        ...detailsOptions,
        ...(options.selected ? { selected: options.selected } : {}),
        ...(options.showDetailsPanel !== undefined ? { showDetailsPanel: options.showDetailsPanel } : {}),
        ...(options.pageSize ? { pageSize: options.pageSize } : {}),
    });
    if (result.value === null) throw new UserCancelled();

    return result.value;
}
