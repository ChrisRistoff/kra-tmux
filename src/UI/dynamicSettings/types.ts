/**
 * Schema model derived from `settings.toml.example`.
 *
 * The example file IS the schema:
 *   - structure  → tree of sections / collections / maps / leaves
 *   - values     → defaults
 *   - comments   → descriptions
 *
 * The user's `settings.toml` is just persisted overrides. The renderer walks
 * the schema and looks up live values; the rewriter mutates the user file
 * line-by-line so comments are preserved.
 *
 * Magic comments (all optional) on a key line:
 *   # @label: Pretty label    – override the displayed name
 *   # @choices: a,b,c         – render as picker instead of free text
 *   # @secret                 – mask value as ******** in lists
 * On a section header line:
 *   # @map                    – force-treat this section as a map of named entries
 *   # @collection-key: alias  – which leaf to use as the display id for collections/maps
 */

export type LeafType =
    | 'bool'
    | 'number'
    | 'string'
    | 'string-array'
    | 'unknown';

export interface LeafNode {
    kind: 'leaf';
    /** Dotted path from the root, e.g. ['ai','agent','memory','enabled']. */
    path: string[];
    /** Last segment of `path` — the bare key. */
    key: string;
    type: LeafType;
    /** Default from the example file. */
    default: unknown;
    description?: string;
    label?: string;
    choices?: string[];
    secret?: boolean;
}

export interface SectionNode {
    kind: 'section';
    path: string[];
    title: string;
    description?: string;
    label?: string;
    /** Ordered children (leaves first, then sub-containers). */
    children: SchemaNode[];
}

/** [[path]] table-array. Item shape derived from the first existing entry. */
export interface CollectionNode {
    kind: 'collection';
    path: string[];
    title: string;
    description?: string;
    label?: string;
    /** Leaf shape of one item, derived from the template entry. */
    itemFields: LeafNode[];
    /** Optional nested sub-sections inside each item (rare). */
    itemSections: SectionNode[];
    /** Which leaf to show as the entry's display id (e.g. 'alias'). */
    displayKey?: string;
}

/** [path.<dynamic>] siblings sharing a shape. */
export interface MapNode {
    kind: 'map';
    path: string[];
    title: string;
    description?: string;
    label?: string;
    itemFields: LeafNode[];
    itemSections: SectionNode[];
    /** Optional: explicit display key. Defaults to the segment name itself. */
    displayKey?: string;
}

export type SchemaNode = LeafNode | SectionNode | CollectionNode | MapNode;

export interface Schema {
    /** Ordered top-level children of the root. */
    children: SchemaNode[];
}
