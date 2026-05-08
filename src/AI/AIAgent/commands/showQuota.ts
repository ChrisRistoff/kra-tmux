import fs from 'fs/promises';
import path from 'path';
import { getGithubToken } from '@/AI/AIAgent/shared/utils/agentSettings';
import { loadSettings } from '@/utils/common';
import { kraHome } from '@/filePaths';

interface QuotaDisplaySettings {
    copilot: boolean;
    claude: boolean;
}

async function loadQuotaDisplaySettings(): Promise<QuotaDisplaySettings> {
    try {
        const s = await loadSettings();
        const q = s.ai?.agent?.quota;

        return {
            copilot: typeof q?.copilot === 'boolean' ? q.copilot : true,
            claude: typeof q?.claude === 'boolean' ? q.claude : true,
        };
    } catch {
        return { copilot: true, claude: true };
    }
}

const CLAUDE_LABELS: Record<string, string> = {
    'five_hour': '5-hour window',
    'seven_day': '7-day window',
    'seven_day_opus': '7-day Opus',
    'seven_day_sonnet': '7-day Sonnet',
    'overage': 'Overage',
    'unknown': 'Rate limit',
};

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

function monthlySnapshotLines(name: string, snap: QuotaSnapshot): string[] {
    const bar = buildBar(snap.percent_remaining);
    const used = snap.entitlement - snap.remaining;
    const out = [
        `  ${name}:`,
        `    ${bar} ${snap.percent_remaining.toFixed(1)}% remaining`,
        `    ${used} / ${snap.entitlement} used  (${snap.remaining} left)`,
    ];

    if (snap.overage_permitted) {
        out.push(`    Overage: ${snap.overage_count} extra requests used`);
    }

    return out;
}

function cachedSnapshotLines(name: string, snap: CachedQuotaSnapshot, updatedAt: string): string[] {
    const bar = buildBar(snap.remainingPercentage);
    const resetStr = snap.resetDate
        ? new Date(snap.resetDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
        : 'unknown';
    const ageMin = Math.round((Date.now() - new Date(updatedAt).getTime()) / 60000);

    return [
        `  ${name}:`,
        `    ${bar} ${snap.remainingPercentage.toFixed(1)}% remaining`,
        `    Resets: ${resetStr}  (cached ${ageMin}m ago)`,
    ];
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
function visibleWidth(s: string): number {
    return [...s.replace(ANSI_RE, '')].length;
}
function padRightVisible(s: string, width: number): string {
    const pad = width - visibleWidth(s);

    return pad > 0 ? s + ' '.repeat(pad) : s;
}

function renderSideBySide(left: string[], right: string[], gap = 4): void {
    if (left.length === 0) {
        for (const line of right) console.log(line);

        return;
    }
    if (right.length === 0) {
        for (const line of left) console.log(line);

        return;
    }

    const leftWidth = Math.max(...left.map(visibleWidth));
    const termWidth = process.stdout.columns ?? 120;
    const rightWidth = Math.max(...right.map(visibleWidth));

    if (leftWidth + gap + rightWidth > termWidth) {
        for (const line of left) console.log(line);
        for (const line of right) console.log(line);

        return;
    }

    const rows = Math.max(left.length, right.length);
    const padStr = ' '.repeat(gap);
    for (let i = 0; i < rows; i++) {
        const l = left[i] ?? '';
        const r = right[i] ?? '';
        console.log(padRightVisible(l, leftWidth) + padStr + r);
    }
}

async function readQuotaCache(): Promise<QuotaCache | null> {
    try {
        return JSON.parse(await fs.readFile(quotaCachePath(), 'utf8')) as QuotaCache;
    } catch {
        return null;
    }
}

export async function showQuota(): Promise<void> {
    const settings = await loadQuotaDisplaySettings();
    const cache = await readQuotaCache();

    if (!settings.copilot && !settings.claude) {
        console.log('\n  \x1b[2m(All quota providers disabled in [ai.agent.quota] settings)\x1b[0m\n');

        return;
    }

    const left = settings.copilot ? await buildCopilotSection(cache) : [];
    const right = settings.claude ? buildClaudeSection(cache) : [];

    console.log('');
    renderSideBySide(left, right);
    console.log('');
}

async function buildCopilotSection(cache: QuotaCache | null): Promise<string[]> {
    const token = getGithubToken();
    const out: string[] = [];

    if (!token) {
        out.push('\x1b[1mCopilot Quota\x1b[0m');
        out.push('  \x1b[2m(No GitHub token found — set GITHUB_TOKEN, GH_TOKEN, or GITHUB_API.)\x1b[0m');

        return out;
    }

    let response: Response;
    try {
        response = await fetch('https://api.github.com/copilot_internal/user', {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github+json',
            },
        });
    } catch (err) {
        out.push('\x1b[1mCopilot Quota\x1b[0m');
        out.push(`  \x1b[2m(Network error fetching Copilot quota: ${(err as Error).message})\x1b[0m`);

        return out;
    }

    if (!response.ok) {
        out.push('\x1b[1mCopilot Quota\x1b[0m');
        out.push(`  \x1b[2m(Failed to fetch Copilot quota: ${response.status} ${response.statusText})\x1b[0m`);

        return out;
    }

    const data = await response.json() as CopilotUserResponse;
    const { quota_snapshots: quotaSnapshots, quota_reset_date_utc: quotaResetDateUtc } = data;

    const resetDate = new Date(quotaResetDateUtc).toLocaleDateString(undefined, {
        year: 'numeric', month: 'long', day: 'numeric',
    });

    out.push('\x1b[1mCopilot Quota — Monthly\x1b[0m');
    out.push(`  Resets on: ${resetDate}`);
    out.push('');

    if (quotaSnapshots.premium_interactions) {
        out.push(...monthlySnapshotLines('Premium interactions', quotaSnapshots.premium_interactions));
    }

    const sessionSnapshots = cache
        ? Object.entries(cache.snapshots).filter(([id, s]) => SESSION_SNAPSHOT_KEYS.has(id) && !s.isUnlimitedEntitlement)
        : [];

    if (sessionSnapshots.length > 0) {
        out.push('');
        out.push('\x1b[1mCopilot Quota — Usage Limits (last session)\x1b[0m');
        out.push('');
        for (const [id, snap] of sessionSnapshots) {
            out.push(...cachedSnapshotLines(id.charAt(0).toUpperCase() + id.slice(1), snap, cache!.updatedAt));
        }
    } else {
        out.push('');
        out.push('  \x1b[2m(Weekly/session limits shown here after your first AI session)\x1b[0m');
    }

    return out;
}

function buildClaudeSection(cache: QuotaCache | null): string[] {
    const claudeSnapshots = cache
        ? Object.entries(cache.snapshots).filter(([id]) => id.startsWith('claude:'))
        : [];

    const out: string[] = [];
    out.push('\x1b[1mClaude Quota — Subscription Limits\x1b[0m');

    if (claudeSnapshots.length === 0) {
        out.push('  \x1b[2m(Shown after your first Claude session emits a rate-limit event.)\x1b[0m');
        out.push('  \x1b[2mAPI-key users are not subscription-rate-limited; this is for Pro/Max OAuth.\x1b[0m');

        return out;
    }

    out.push('');
    for (const [id, snap] of claudeSnapshots) {
        const suffix = id.slice('claude:'.length);
        const label = CLAUDE_LABELS[suffix] ?? suffix;
        out.push(...cachedSnapshotLines(label, snap, cache!.updatedAt));
    }

    return out;
}
