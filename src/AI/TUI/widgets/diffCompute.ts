/**
 * Line-level LCS diff helper used by the diff-review modal.
 *
 * Backed by `diff-sequences` (jest's Myers implementation, already a
 * transitive dep). Returns a flat list of segments tagged as `equal`,
 * `add`, `remove`, or `change` so the renderer can colour each line.
 */

import diffSequences from 'diff-sequences';

export type DiffOpKind = 'equal' | 'add' | 'remove' | 'change';

export interface DiffSegment {
    kind: DiffOpKind;
    /** Lines from the CURRENT (left) buffer covered by this segment. */
    currentLines: string[];
    /** Lines from the PROPOSED (right) buffer covered by this segment. */
    proposedLines: string[];
    /** 0-based starting indices for cross-referencing the originals. */
    currentStart: number;
    proposedStart: number;
}

/** Compute line-aligned diff segments. */
export function diffLines(current: string[], proposed: string[]): DiffSegment[] {
    const isCommon = (aIdx: number, bIdx: number): boolean => current[aIdx] === proposed[bIdx];

    const matches: Array<[number, number, number]> = [];
    diffSequences(current.length, proposed.length, isCommon, (n: number, aStart: number, bStart: number) => {
        matches.push([aStart, bStart, n]);
    });

    const segments: DiffSegment[] = [];
    let aCursor = 0;
    let bCursor = 0;

    const flushDiff = (aEnd: number, bEnd: number): void => {
        const aSlice = current.slice(aCursor, aEnd);
        const bSlice = proposed.slice(bCursor, bEnd);
        if (aSlice.length === 0 && bSlice.length === 0) return;
        let kind: DiffOpKind;
        if (aSlice.length === 0) kind = 'add';
        else if (bSlice.length === 0) kind = 'remove';
        else kind = 'change';
        segments.push({
            kind,
            currentLines: aSlice,
            proposedLines: bSlice,
            currentStart: aCursor,
            proposedStart: bCursor,
        });
    };

    for (const [aStart, bStart, n] of matches) {
        flushDiff(aStart, bStart);
        if (n > 0) {
            segments.push({
                kind: 'equal',
                currentLines: current.slice(aStart, aStart + n),
                proposedLines: proposed.slice(bStart, bStart + n),
                currentStart: aStart,
                proposedStart: bStart,
            });
        }
        aCursor = aStart + n;
        bCursor = bStart + n;
    }
    flushDiff(current.length, proposed.length);

    return segments;
}

/** Return aggregate `+added / -removed` line counts for a status line. */
export function diffStats(segments: DiffSegment[]): { added: number, removed: number } {
    let added = 0;
    let removed = 0;
    for (const s of segments) {
        if (s.kind === 'add') added += s.proposedLines.length;
        else if (s.kind === 'remove') removed += s.currentLines.length;
        else if (s.kind === 'change') {
            added += s.proposedLines.length;
            removed += s.currentLines.length;
        }
    }

    return { added, removed };
}
