import blessed from 'blessed';

export interface ExpandableTreeRow {
    id: string;
    depth: number;
    expandable: boolean;
    isOpen?: boolean;
}

type TreeWidget = blessed.Widgets.ListElement & {
    key: (keys: string[] | string, handler: () => void) => unknown;
    select: (index: number) => void;
};

export function toggleExpandedRow<Row extends ExpandableTreeRow>(
    row: Row | undefined,
    expanded: Set<string>,
    rebuild: (preserveId?: string) => void,
): boolean {
    if (!row?.expandable) return false;
    if (expanded.has(row.id)) expanded.delete(row.id);
    else expanded.add(row.id);
    rebuild(row.id);

    return true;
}

export interface TreeExpandCollapseOptions<Row extends ExpandableTreeRow> {
    tree: TreeWidget;
    getRows: () => readonly Row[];
    getSelectedIndex: () => number;
    expanded: Set<string>;
    rebuild: (preserveId?: string) => void;
    onSelect?: (index: number, row: Row) => void;
}

export function attachTreeExpandCollapseKeys<Row extends ExpandableTreeRow>(opts: TreeExpandCollapseOptions<Row>): void {
    const { tree, getRows, getSelectedIndex, expanded, rebuild, onSelect } = opts;

    tree.key(['h', 'left'], () => {
        const rows = getRows();
        const selectedIndex = getSelectedIndex();
        const row = rows[selectedIndex];
        if (!row) return;
        if (row.expandable && row.isOpen) {
            expanded.delete(row.id);
            rebuild(row.id);

            return;
        }

        const parentDepth = row.depth - 1;
        for (let i = selectedIndex - 1; i >= 0; i--) {
            const parent = rows[i];
            if (parent.depth === parentDepth && parent.expandable) {
                tree.select(i);
                onSelect?.(i, parent);

                return;
            }
        }
    });

    tree.key(['l', 'right'], () => {
        const rows = getRows();
        const row = rows[getSelectedIndex()];
        if (!row.expandable || row.isOpen) return;
        expanded.add(row.id);
        rebuild(row.id);
    });
}
