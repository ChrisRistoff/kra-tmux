import * as blessed from 'blessed';
import { theme } from '@/UI/dashboard';
import { BG_PANEL } from '../theme';

export type TuiMode = 'NORMAL' | 'INSERT' | 'VISUAL' | 'V-LINE';

export interface StatusBarState {
    mode: TuiMode;
    pane: 'transcript' | 'prompt';
    model: string;
    streaming: boolean;
    title?: string;
    extra?: string;
}

export interface StatusBar {
    el: blessed.Widgets.BoxElement;
    set: (patch: Partial<StatusBarState>) => void;
    get: () => StatusBarState;
}

const MODE_BG: Record<TuiMode, string> = {
    NORMAL: 'blue',
    INSERT: 'green',
    VISUAL: 'magenta',
    'V-LINE': 'magenta',
};

export function createStatusBar(
    parent: blessed.Widgets.Node,
    initial: StatusBarState,
): StatusBar {
    const state: StatusBarState = { ...initial };

    const el = blessed.box({
        parent,
        top: 0,
        left: 0,
        right: 0,
        height: 1,
        tags: true,
        style: { bg: BG_PANEL },
    });

    const render = (): void => {
        const modeBg = MODE_BG[state.mode] || 'blue';
        const modeChip = `{black-fg}{${modeBg}-bg} ${state.mode} {/${modeBg}-bg}{/black-fg}`;
        const paneChip = `{gray-fg}[${state.pane}]{/gray-fg}`;
        const dot = state.streaming ? '{green-fg}●{/green-fg}' : '{gray-fg}○{/gray-fg}';
        const title = state.title ? ` ${theme.title(state.title)}` : '';
        const model = theme.dim(state.model);
        const extra = state.extra ? `  ${theme.dim(state.extra)}` : '';
        el.setContent(` ${modeChip} ${paneChip}${title}  ${dot} ${model}${extra}`);
    };

    render();

    return {
        el,
        get: () => ({ ...state }),
        set: (patch) => {
            Object.assign(state, patch);
            render();
        },
    };
}
