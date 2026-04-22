import * as fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { AgentConversationState } from '@/AI/AIAgent/types/agentTypes';

const QUOTA_WARN_THRESHOLDS = [50, 25, 10];
const QUOTA_CACHE_PATH = path.join(os.homedir(), '.local', 'share', 'kra-tmux', 'quota-cache.json');

/**
 * Listen for `assistant.usage` events on the session, persist quota snapshots
 * to disk for `kra ai quota` to read, and emit a console warning the first time
 * a quota crosses each threshold (50% / 25% / 10% remaining).
 */
export function setupQuotaTracking(state: AgentConversationState): void {
    const warnedThresholds = new Set<string>();

    state.session.on('assistant.usage', (event) => {
        const snapshots = event.data.quotaSnapshots;
        if (!snapshots) return;

        // Persist for `kra ai quota` to read
        const cache: Record<string, { remainingPercentage: number; resetDate: string | null; isUnlimitedEntitlement: boolean }> = {};
        for (const [id, snap] of Object.entries(snapshots)) {
            cache[id] = {
                remainingPercentage: snap.remainingPercentage,
                resetDate: snap.resetDate ?? null,
                isUnlimitedEntitlement: snap.isUnlimitedEntitlement,
            };
        }
        fs.mkdir(path.dirname(QUOTA_CACHE_PATH), { recursive: true })
            .then(async () => fs.writeFile(QUOTA_CACHE_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), snapshots: cache }, null, 2)))
            .catch(() => { /* non-critical */ });

        for (const [quota_id, snap] of Object.entries(snapshots)) {
            if (snap.isUnlimitedEntitlement) continue;

            const pct = snap.remainingPercentage;
            const resetDate = snap.resetDate ? new Date(snap.resetDate).toLocaleString() : 'unknown';

            for (const threshold of QUOTA_WARN_THRESHOLDS) {
                const key = `${quota_id}:${threshold}`;
                if (pct <= threshold && !warnedThresholds.has(key)) {
                    warnedThresholds.add(key);
                    const label = quota_id === 'weekly' ? 'weekly usage limit' : `${quota_id} usage limit`;
                    const color = pct <= 10 ? '\x1b[31m' : '\x1b[33m';
                    console.warn(`\n${color}⚠ You've used over ${100 - threshold}% of your ${label}. Resets: ${resetDate}\x1b[0m\n`);
                }
            }
        }
    });
}
