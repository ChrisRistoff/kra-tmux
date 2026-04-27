import fs from 'fs/promises';
import path from 'path';
import { getGithubToken } from '@/AI/AIAgent/shared/utils/agentSettings';
import { kraHome } from '@/filePaths';

const quotaCachePath = (): string => path.join(kraHome(), 'quota-cache.json');

interface QuotaSnapshot {
    percent_remaining: number;
    remaining: number;
    entitlement: number;
    unlimited: boolean;
    overage_permitted: boolean;
    overage_count: number;
}

interface CopilotUserResponse {
    quota_reset_date_utc: string;
    quota_snapshots: {
        premium_interactions?: QuotaSnapshot;
    };
}

interface CachedQuotaSnapshot {
    remainingPercentage: number;
    resetDate: string | null;
    isUnlimitedEntitlement: boolean;
}

interface QuotaCache {
    updatedAt: string;
    snapshots: Record<string, CachedQuotaSnapshot>;
}

const SESSION_SNAPSHOT_KEYS = new Set(['weekly', 'session']);

function buildBar(percentRemaining: number, width = 30): string {
    const filled = Math.round((percentRemaining / 100) * width);
    const bar = '█'.repeat(filled) + '░'.repeat(width - filled);

    if (percentRemaining <= 10) return `\x1b[31m${bar}\x1b[0m`;
    if (percentRemaining <= 25) return `\x1b[33m${bar}\x1b[0m`;

    return `\x1b[32m${bar}\x1b[0m`;
}

function formatMonthlySnapshot(name: string, snap: QuotaSnapshot): void {
    const bar = buildBar(snap.percent_remaining);
    const used = snap.entitlement - snap.remaining;

    console.log(`  ${name}:`);
    console.log(`    ${bar} ${snap.percent_remaining.toFixed(1)}% remaining`);
    console.log(`    ${used} / ${snap.entitlement} used  (${snap.remaining} left)`);

    if (snap.overage_permitted) {
        console.log(`    Overage: ${snap.overage_count} extra requests used`);
    }
}

function formatCachedSnapshot(name: string, snap: CachedQuotaSnapshot, updatedAt: string): void {
    const bar = buildBar(snap.remainingPercentage);
    const resetStr = snap.resetDate
        ? new Date(snap.resetDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
        : 'unknown';
    const ageMin = Math.round((Date.now() - new Date(updatedAt).getTime()) / 60000);

    console.log(`  ${name}:`);
    console.log(`    ${bar} ${snap.remainingPercentage.toFixed(1)}% remaining`);
    console.log(`    Resets: ${resetStr}  (cached ${ageMin}m ago)`);
}

async function readQuotaCache(): Promise<QuotaCache | null> {
    try {
        return JSON.parse(await fs.readFile(quotaCachePath(), 'utf8')) as QuotaCache;
    } catch {
        return null;
    }
}

export async function showQuota(): Promise<void> {
    const token = getGithubToken();

    if (!token) {
        throw new Error('No GitHub token found. Set GITHUB_TOKEN, GH_TOKEN, or GITHUB_API.');
    }

    const response = await fetch('https://api.github.com/copilot_internal/user', {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
        },
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch Copilot quota: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as CopilotUserResponse;
    const { quota_snapshots: quotaSnapshots, quota_reset_date_utc: quotaResetDateUtc } = data;

    const resetDate = new Date(quotaResetDateUtc).toLocaleDateString(undefined, {
        year: 'numeric', month: 'long', day: 'numeric',
    });

    console.log('\n\x1b[1mCopilot Quota — Monthly\x1b[0m');
    console.log(`  Resets on: ${resetDate}\n`);

    if (quotaSnapshots.premium_interactions) {
        formatMonthlySnapshot('Premium interactions', quotaSnapshots.premium_interactions);
    }

    const cache = await readQuotaCache();
    const sessionSnapshots = cache
        ? Object.entries(cache.snapshots).filter(([id, s]) => SESSION_SNAPSHOT_KEYS.has(id) && !s.isUnlimitedEntitlement)
        : [];

    if (sessionSnapshots.length > 0) {
        console.log('\n\x1b[1mCopilot Quota — Usage Limits (last session)\x1b[0m\n');
        for (const [id, snap] of sessionSnapshots) {
            formatCachedSnapshot(id.charAt(0).toUpperCase() + id.slice(1), snap, cache!.updatedAt);
        }
    } else {
        console.log('\n  \x1b[2m(Weekly/session limits shown here after your first AI session)\x1b[0m');
    }

    console.log('');
}
