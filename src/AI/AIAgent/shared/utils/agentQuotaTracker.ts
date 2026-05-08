import * as fs from 'fs/promises';
import path from 'path';
import type { AgentConversationState } from '@/AI/AIAgent/shared/types/agentTypes';
import { kraHome } from '@/filePaths';

const QUOTA_WARN_THRESHOLDS = [50, 25, 10];
const quotaCachePath = (): string => path.join(kraHome(), 'quota-cache.json');

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

        const cachePath = quotaCachePath();
        fs.mkdir(path.dirname(cachePath), { recursive: true })
            .then(async () => fs.writeFile(cachePath, JSON.stringify({ updatedAt: new Date().toISOString(), snapshots: cache }, null, 2)))
            .catch(() => { /* non-critical */ });

        for (const [quotaId, snap] of Object.entries(snapshots)) {
            if (snap.isUnlimitedEntitlement) continue;

            const pct = snap.remainingPercentage;
            const resetDate = snap.resetDate ? new Date(snap.resetDate).toLocaleString() : 'unknown';

            for (const threshold of QUOTA_WARN_THRESHOLDS) {
                const key = `${quotaId}:${threshold}`;
                if (pct <= threshold && !warnedThresholds.has(key)) {
                    warnedThresholds.add(key);
                    let label: string;
                    if (quotaId.startsWith('claude:')) {
                        const suffix = quotaId.slice('claude:'.length);
                        const claudeLabels: Record<string, string> = {
                            'five_hour': 'Claude 5-hour limit',
                            'seven_day': 'Claude 7-day limit',
                            'seven_day_opus': 'Claude 7-day Opus limit',
                            'seven_day_sonnet': 'Claude 7-day Sonnet limit',
                            'overage': 'Claude overage limit',
                        };
                        label = claudeLabels[suffix] ?? `Claude ${suffix} limit`;
                    } else if (quotaId === 'weekly') {
                        label = 'weekly usage limit';
                    } else {
                        label = `${quotaId} usage limit`;
                    }
                    const color = pct <= 10 ? '\x1b[31m' : '\x1b[33m';
                    console.warn(`\n${color}⚠ You've used over ${100 - threshold}% of your ${label}. Resets: ${resetDate}\x1b[0m\n`);
                }
            }
        }
    });
}
