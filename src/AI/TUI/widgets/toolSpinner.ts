import * as blessed from 'blessed';
import { markOverlay } from '../state/popupRegistry';
import { BG_PANEL, BORDER_DIM } from '../theme';

interface ActiveEntry {
    callId: string;
    toolName: string;
    summary: string;
    argsJson: string;
    /** Full multi-line details string built by the agent (Arguments,
     *  progress, etc.). Shown in the indicator under the tool name so
     *  the user can see WHAT the tool is doing without opening the
     *  history popup — mirrors how the nvim plugin formats the body. */
    details: string;
    startedAt: number;
}

interface RecentEntry {
    toolName: string;
    summary: string;
    success: boolean;
    finishedAt: number;
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const RECENT_LINGER_MS = 2500;
const MAX_RECENT = 3;
const BODY_WIDTH = 70;

/**
 * Top-right floating popup that shows currently-running tool calls with
 * a spinner, plus the last few completed ones for ~2.5s. Mirrors the
 * old nvim popup that the chat used before the migration to blessed.
 *
 * Visibility is delegated to PopupRegistry so the user can blanket-hide
 * it with the global "hide popups" toggle (<space> t).
 */
export class ToolSpinnerWidget {
    private box: blessed.Widgets.BoxElement;
    private active = new Map<string, ActiveEntry>();
    private recent: RecentEntry[] = [];
    private frame = 0;
    private timer: NodeJS.Timeout | null = null;
    private fallbackSeq = 0;

    constructor(private screen: blessed.Widgets.Screen) {
        this.box = blessed.box({
            parent: screen,
            top: 1,
            right: 1,
            width: 80,
            height: 'shrink' as unknown as number,
            label: ' Tools ',
            border: { type: 'line' },
            style: { border: { fg: BORDER_DIM }, bg: BG_PANEL },
            tags: true,
        });
        this.box.hide();
        this.box.setFront();
        markOverlay(this.box);
    }

    start(input: { toolName: string, summary: string, details?: string, argsJson?: string, callId?: string }): void {
        const callId = input.callId ?? `__nokey_${++this.fallbackSeq}`;
        this.active.set(callId, {
            callId,
            toolName: input.toolName,
            summary: input.summary,
            details: input.details ?? '',
            argsJson: input.argsJson ?? '',
            startedAt: Date.now(),
        });
        this.render();
        this.ensureTicking();
    }

    /** Refresh an in-flight entry's summary/details (e.g. when a tool
     *  emits a progress message). No-op if the entry is unknown. */
    update(input: { toolName: string, summary?: string, details?: string, callId?: string }): void {
        let target: ActiveEntry | undefined;
        if (input.callId && this.active.has(input.callId)) {
            target = this.active.get(input.callId);
        } else {
            for (const v of this.active.values()) {
                if (v.toolName === input.toolName) { target = v; break; }
            }
        }
        if (!target) return;
        if (input.summary !== undefined) target.summary = input.summary;
        if (input.details !== undefined) target.details = input.details;
        this.render();
    }

    complete(input: { toolName: string, success: boolean, callId?: string }): void {
        let target: ActiveEntry | undefined;
        if (input.callId && this.active.has(input.callId)) {
            target = this.active.get(input.callId);
            this.active.delete(input.callId);
        } else {
            for (const [k, v] of this.active) {
                if (v.toolName === input.toolName) {
                    target = v;
                    this.active.delete(k);
                    break;
                }
            }
        }
        const summary = target?.summary ?? input.toolName;
        this.recent.unshift({
            toolName: input.toolName,
            summary,
            success: input.success,
            finishedAt: Date.now(),
        });
        if (this.recent.length > MAX_RECENT) this.recent.length = MAX_RECENT;
        this.render();
        this.ensureTicking();
    }

    private ensureTicking(): void {
        const needsTick = this.active.size > 0 || this.recent.length > 0;
        if (needsTick && !this.timer) {
            this.timer = setInterval(() => {
                this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
                // Drop expired recents.
                const now = Date.now();
                const before = this.recent.length;
                this.recent = this.recent.filter((r) => now - r.finishedAt < RECENT_LINGER_MS);
                if (this.recent.length !== before || this.active.size > 0) this.render();
                else this.render();
                if (this.active.size === 0 && this.recent.length === 0) {
                    this.stopTicking();
                }
            }, 100);
        } else if (!needsTick && this.timer) {
            this.stopTicking();
        }
    }

    private stopTicking(): void {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
    }

    private render(): void {
        if (this.active.size === 0 && this.recent.length === 0) {
            this.box.hide();
            this.screen.render();

            return;
        }
        if ((this.box as unknown as { __kraHidden?: boolean }).__kraHidden) {
            // Globally hidden by PopupRegistry — don't fight the user.
            this.screen.render();

            return;
        }
        const sp = SPINNER_FRAMES[this.frame];
        const lines: string[] = [];
        for (const e of this.active.values()) {
            const elapsed = formatElapsed(Date.now() - e.startedAt);
            lines.push(` {#d4b860-fg}${sp}{/} {bold}${escapeTags(e.toolName)}{/bold}  {gray-fg}${elapsed}{/gray-fg}`);
            if (e.summary) {
                lines.push(`   {#7fb8c9-fg}${escapeTags(truncate(e.summary, BODY_WIDTH))}{/}`);
            }
            // Prefer the rich `details` body over a flat argsJson dump.
            // It already includes "Arguments: …" / "Streaming tool output…"
            // / progress text built by the agent. Fallback to argPreview
            // when no details were supplied (older code paths).
            const detailLines = pickDetailLines(e.details, 6);
            if (detailLines.length > 0) {
                for (const detail of detailLines) {
                    lines.push(`   {gray-fg}${escapeTags(truncate(detail, BODY_WIDTH))}{/gray-fg}`);
                }
            } else {
                for (const detail of argPreview(e.argsJson, 3)) {
                    lines.push(`   {gray-fg}${escapeTags(truncate(detail, BODY_WIDTH))}{/gray-fg}`);
                }
            }
        }
        if (this.active.size > 0 && this.recent.length > 0) {
            lines.push(' {gray-fg}──────────────────────────────────────{/gray-fg}');
        }
        for (const r of this.recent) {
            const icon = r.success ? '{green-fg}\u2713{/green-fg}' : '{red-fg}\u2717{/red-fg}';
            const name = r.success
                ? `{green-fg}${escapeTags(r.toolName)}{/green-fg}`
                : `{red-fg}${escapeTags(r.toolName)}{/red-fg}`;
            lines.push(` ${icon} ${name}  {gray-fg}${escapeTags(truncate(r.summary, BODY_WIDTH))}{/gray-fg}`);
        }
        this.box.height = lines.length + 2;
        this.box.setContent(lines.join('\n'));
        this.box.show();
        this.box.setFront();
        this.screen.render();
    }
}

function escapeTags(s: string): string {
    return s.replace(/[{}]/g, (c) => (c === '{' ? '{open}' : '{close}'));
}

function truncate(s: string, max: number): string {
    if (s.length <= max) return s;

    return s.slice(0, max - 1) + '\u2026';
}

function formatElapsed(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);

    return `${m}m${r.toString().padStart(2, '0')}s`;
}

/** Pick a compact slice of the agent's `details` string for display
 *  in the tool indicator. Drops the first "Running <tool>" header line
 *  (it duplicates info we already show), trims blanks, and caps to
 *  `maxRows`. */
function pickDetailLines(details: string, maxRows: number): string[] {
    if (!details) return [];
    const raw = details.split('\n');
    const out: string[] = [];
    let skippedHeader = false;
    for (const line of raw) {
        const trimmed = line.trim();
        if (!skippedHeader && /^Running\s+/i.test(trimmed)) {
            skippedHeader = true;
            continue;
        }
        if (trimmed.length === 0) continue;
        out.push(trimmed);
        if (out.length >= maxRows) break;
    }
    if (raw.length > out.length + (skippedHeader ? 1 : 0)) {
        out.push('…');
    }

    return out;
}

function argPreview(argsJson: string, maxRows: number): string[] {
    if (!argsJson) return [];
    let parsed: unknown;
    try { parsed = JSON.parse(argsJson); } catch { return []; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    const entries = Object.entries(parsed as Record<string, unknown>);
    const out: string[] = [];
    for (const [k, v] of entries) {
        if (out.length >= maxRows) break;
        let val: string;
        if (v === null) val = 'null';
        else if (typeof v === 'string') val = v;
        else if (typeof v === 'number' || typeof v === 'boolean') val = String(v);
        else { try { val = JSON.stringify(v); } catch { val = '…'; } }
        out.push(`• ${k}: ${val}`);
    }
    if (entries.length > out.length) out.push(`• … (+${entries.length - out.length} more)`);

    return out;
}
