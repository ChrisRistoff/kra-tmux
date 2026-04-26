/**
 * Argument coercion helpers used by the fileContext MCP tool handlers.
 *
 * Some agents JSON-encode array or number arguments as strings (e.g. "[1, 5]"
 * or "42"). These helpers normalise them back to structured values so each
 * handler can validate uniformly regardless of how the model formatted them.
 */

export function getArgs(params: unknown): Record<string, unknown> {
    if (typeof params === 'object' && params !== null) {
        const p = params as Record<string, unknown>;

        if (typeof p.arguments === 'object' && p.arguments !== null) {
            return p.arguments as Record<string, unknown>;
        }
    }

    return {};
}

export function coerceArray(value: unknown): unknown[] | undefined {
    if (Array.isArray(value)) return value;

    if (typeof value === 'string') {
        try {
            const parsed: unknown = JSON.parse(value);

            return Array.isArray(parsed) ? parsed : undefined;
        } catch {
            return undefined;
        }
    }

    return undefined;
}

export function coerceNumberArray(value: unknown): number[] | undefined {
    const arr = coerceArray(value);

    if (!arr) return undefined;

    const out: number[] = [];

    for (const v of arr) {
        if (typeof v === 'number' && Number.isFinite(v)) {
            out.push(v);
        } else if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
            out.push(Number(v));
        } else {
            return undefined;
        }
    }

    return out;
}

export function coerceStringArray(value: unknown): string[] | undefined {
    const arr = coerceArray(value);

    if (!arr) return undefined;

    const out: string[] = [];

    for (const v of arr) {
        if (typeof v === 'string') {
            out.push(v);
        } else {
            return undefined;
        }
    }

    return out;
}

export function coerceNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;

    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
        return Number(value);
    }

    return undefined;
}
