/**
 * In-memory ring buffer of tool-call lifecycle entries shown in the chat
 * TUI's history panel (Ctrl-H). Capped to avoid monotonic growth.
 */

export interface ToolHistoryEntry {
    id: number;
    toolName: string;
    summary: string;
    argsJson: string;
    status: 'running' | 'ok' | 'fail';
    startedAt: number;
    finishedAt?: number;
    result?: string;
    callId?: string;
}

const MAX_ENTRIES = 200;

export class ToolHistoryStore {
    private entries: ToolHistoryEntry[] = [];
    private nextId = 1;

    list(): ToolHistoryEntry[] {
        return this.entries;
    }

    start(input: { toolName: string, summary: string, argsJson: string, callId?: string }): ToolHistoryEntry {
        const entry: ToolHistoryEntry = {
            id: this.nextId++,
            toolName: input.toolName,
            summary: input.summary,
            argsJson: input.argsJson,
            status: 'running',
            startedAt: Date.now(),
            ...(input.callId ? { callId: input.callId } : {}),
        };
        this.entries.push(entry);
        if (this.entries.length > MAX_ENTRIES) {
            this.entries.splice(0, this.entries.length - MAX_ENTRIES);
        }
        return entry;
    }

    complete(input: { toolName: string, success: boolean, result: string, callId?: string }): void {
        // Match by callId first; fall back to last running entry of same toolName.
        let target: ToolHistoryEntry | undefined;
        if (input.callId) {
            for (let i = this.entries.length - 1; i >= 0; i--) {
                if (this.entries[i].callId === input.callId) { target = this.entries[i]; break; }
            }
        }
        if (!target) {
            for (let i = this.entries.length - 1; i >= 0; i--) {
                if (this.entries[i].toolName === input.toolName && this.entries[i].status === 'running') {
                    target = this.entries[i];
                    break;
                }
            }
        }
        if (!target) {
            // Synthesize a placeholder so a stray complete still surfaces.
            target = this.start({ toolName: input.toolName, summary: '(no start_tool seen)', argsJson: '{}', ...(input.callId ? { callId: input.callId } : {}) });
        }
        target.status = input.success ? 'ok' : 'fail';
        target.finishedAt = Date.now();
        target.result = input.result;
    }

    clear(): void {
        this.entries = [];
    }
}
