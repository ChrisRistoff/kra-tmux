// Shared semantic color palette for blessed dashboards.
//
// Use these helpers instead of inline {color-fg}…{/color-fg} tags so the look
// stays consistent across dashboards and we can re-skin in one place.
//
// All helpers accept a string-coercible value and return a blessed-tagged
// string. They DO NOT escape the value — pass already-escaped content if it
// contains user data with `{` or `}` characters.

const wrap = (open: string, close: string) => (s: string | number): string =>
    `${open}${s}${close}`;

export const theme = {
    label:   wrap('{cyan-fg}', '{/cyan-fg}'),
    value:   wrap('{white-fg}', '{/white-fg}'),
    dim:     wrap('{gray-fg}', '{/gray-fg}'),
    path:    wrap('{blue-fg}', '{/blue-fg}'),
    dir:     wrap('{blue-fg}', '{/blue-fg}'),
    file:    wrap('{green-fg}', '{/green-fg}'),
    link:    wrap('{magenta-fg}', '{/magenta-fg}'),
    size:    wrap('{green-fg}', '{/green-fg}'),
    date:    wrap('{magenta-fg}', '{/magenta-fg}'),
    count:   wrap('{yellow-fg}', '{/yellow-fg}'),
    key:     wrap('{cyan-fg}', '{/cyan-fg}'),
    section: wrap('{magenta-fg}{bold}', '{/bold}{/magenta-fg}'),
    title:   wrap('{cyan-fg}{bold}', '{/bold}{/cyan-fg}'),
    success: wrap('{green-fg}', '{/green-fg}'),
    warn:    wrap('{yellow-fg}', '{/yellow-fg}'),
    err:     wrap('{red-fg}', '{/red-fg}'),
    hl:      wrap('{yellow-bg}{black-fg}', '{/black-fg}{/yellow-bg}'),
    accent:  wrap('{magenta-fg}', '{/magenta-fg}'),
    selected: wrap('{yellow-fg}', '{/yellow-fg}'),
};

export type ThemeKey = keyof typeof theme;
