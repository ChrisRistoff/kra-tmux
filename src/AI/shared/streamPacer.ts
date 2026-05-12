/**
 * Shared streaming-pacer policy used by both the chat (`chatTui.streamResponse`)
 * and the agent (`agentSessionEvents.flushBuffer`). Centralized so both
 * surfaces have identical typewriter cadence and burst-dump behavior — the
 * two used to drift apart and felt subtly different to users.
 *
 * Policy:
 *  - Below `dumpThreshold`: emit `minChars` per tick (default 1 char / 4 ms
 *    ≈ 250 cps) → smooth letter-by-letter typewriter feel.
 *  - At/above `dumpThreshold` (or when `force` is true): drain everything in
 *    one tick → never let the user stare at a stale tail when a multi-KB
 *    burst lands all at once.
 */

export interface PacerConfig {
    intervalMs: number;
    minChars: number;
    dumpThreshold: number;
}

// Pacer ticks roughly per render frame so each frame paints exactly one new
// glyph — that's what produces the smooth typewriter feel instead of
// 4-char bursts per render. 4 ms (≈ 240 cps) keeps up with most models so
// the buffer rarely hits dumpThreshold. Raise dumpThreshold so when the
// model bursts, we still typewrite chunks up to ~4 KB instead of dumping.
export const DEFAULT_PACER: PacerConfig = {
    intervalMs: 4,
    minChars: 1,
    dumpThreshold: 4000,
};

export function resolvePacerConfig(iface?: {
    pacerIntervalMs?: number;
    pacerMinChars?: number;
    pacerDumpThreshold?: number;
}): PacerConfig {
    return {
        intervalMs: iface?.pacerIntervalMs ?? DEFAULT_PACER.intervalMs,
        minChars: iface?.pacerMinChars ?? DEFAULT_PACER.minChars,
        dumpThreshold: iface?.pacerDumpThreshold ?? DEFAULT_PACER.dumpThreshold,
    };
}

export function computeDrainCount(
    bufferLength: number,
    cfg: PacerConfig,
    force: boolean,
): number {
    if (bufferLength === 0) return 0;
    if (force || bufferLength >= cfg.dumpThreshold) return bufferLength;

    return Math.min(bufferLength, cfg.minChars);
}
