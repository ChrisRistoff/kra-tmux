/**
 * `investigate_web` — orchestrator-facing autonomous web research tool.
 *
 * Mirrors `createInvestigateTool` but for the web. Each call:
 *   1. Mints a fresh `researchId` (UUID) so concurrent investigations stay
 *      isolated in the shared `research_chunks` LanceDB table.
 *   2. Lazily purges TTL-expired rows from previous investigations.
 *   3. Builds a `webResearchTools` factory bound to that `researchId`.
 *   4. Runs the sub-agent with `{ web_search, web_scrape_and_index,
 *      research_query, submit_result }` and a custom system prompt.
 *   5. Optionally validates each evidence excerpt against the indexed chunks.
 *   6. Cleans up the `researchId`'s rows on successful completion.
 *
 * Like `investigate`, only ONE concurrent investigation is allowed (per
 * factory) so the user retains full control.
 */

import { randomUUID } from 'crypto';
import type { MCPServerConfig } from '@/AI/AIAgent/shared/types/mcpConfig';
import type { LocalTool } from '@/AI/AIAgent/shared/types/agentTypes';
import type { WebInvestigatorRuntime } from '@/AI/AIAgent/shared/subAgents/types';
import {
    runSubAgentTask,
    type SubAgentChatBridge,
} from '@/AI/AIAgent/shared/subAgents/session';
import {
    createWebResearchTools,
    type WebResearchToolStats,
} from '@/AI/AIAgent/shared/subAgents/webResearchTools';
import {
    deleteByResearchIds,
    deleteResearchChunksOlderThan,
    searchResearchChunks,
} from '@/AI/AIAgent/shared/memory/researchChunks';
import { embedOne } from '@/AI/AIAgent/shared/memory/embedder';

export interface CreateInvestigateWebToolOptions {
    runtime: WebInvestigatorRuntime;
    /**
     * MCP servers exposed to the sub-agent. The web research tools are
     * `LocalTool`s so they don't need an MCP entry — pass `{}` if no MCP
     * tooling is needed (typical).
     */
    mcpServers: Record<string, MCPServerConfig>;
    workingDirectory: string;
    /**
     * Optional bridge into the orchestrator's chat / approval modal. When set,
     * web-investigator tool calls flow through the same approval modal as
     * orchestrator tool calls (tagged `[INVESTIGATOR-WEB]`).
     */
    chatBridge?: SubAgentChatBridge;
    /**
     * Repo key override for the LanceDB row scoping. Defaults to the value
     * resolved from `WORKING_DIR` / cwd by the memory layer.
     */
    repoKey?: string;
    /**
     * Hook invoked when an investigation starts/finishes — used by the
     * cleanup-on-exit handler in `agentConversation.ts` to track which
     * `researchId`s should be purged on SIGINT.
     */
    onResearchActive?: (researchId: string, active: boolean) => void;
}

export interface WebEvidenceItem {
    url: string;
    title?: string;
    section?: string;
    excerpt: string;
    why_relevant: string;
}

export interface WebInvestigationResult {
    summary: string;
    evidence: WebEvidenceItem[];
    confidence: 'high' | 'medium' | 'low';
    suggested_next?: string;
    /** True when the agent submitted before exhausting all relevant material. */
    partial?: boolean;
    pages_fetched: number;
    pages_failed: number;
    chunks_indexed: number;
    searches: number;
    scrapes: number;
}

interface InvestigateWebArgs {
    questions: string[];
    hint?: string;
}

const INVESTIGATE_WEB_PARAMETERS: Record<string, unknown> = {
    type: 'object',
    properties: {
        questions: {
            type: 'array',
            minItems: 1,
            items: { type: 'string' },
            description: 'ALL related research sub-questions for this investigation, as an array of strings. **One call per scope** — if multiple questions share the same library, vendor, docs source, or topic, list them ALL here so the sub-agent answers them from a single round of fetches. DO NOT issue a second `investigate_web` call for a question that overlaps in scope with one already in this array (or one you just made). Split into separate calls only when topics are genuinely unrelated (different library, different vendor, no shared docs source).',
        },
        hint: {
            type: 'string',
            description: 'Optional steering shared by all questions: known authoritative sources, prior findings, version pins, user context. The web investigator only sees `questions` + `hint` — be generous.',
        },
    },
    required: ['questions'],
    additionalProperties: false,
};

export function createInvestigateWebTool(opts: CreateInvestigateWebToolOptions): LocalTool {
    const { runtime, mcpServers, workingDirectory } = opts;
    const { settings } = runtime;

    let activeRun: Promise<string> | null = null;

    return {
        name: 'investigate_web',
        serverLabel: 'kra-subagent',
        description: [
            'Autonomous web research tool. Spawns a sub-agent that searches the web and',
            'returns a curated {summary, evidence, confidence}. Use for questions whose answer lives outside this',
            'repo: library/SDK behaviour, current ecosystem state, RFCs, vendor docs, recent',
            'developments. NOT for repository code questions — use `investigate` for those.',
            '',
            '**Bundle related sub-questions into the `questions` array — ONE call per scope.**',
            'If two questions would be answered from the same docs / vendor / library, they MUST',
            'go in the same `questions` array on a single call. Issuing a second `investigate_web`',
            'for an overlapping scope re-runs the entire search + fetch + index + synthesis pipeline',
            'and fragments context the sub-agent needs.',
            '',
            'You never see raw page bodies; only short excerpts the sub-agent picked. Pass any',
            'known steering (canonical doc URLs, version, user context) via `hint`. May be called',
            'at any point in the turn. Only ONE web investigation runs at a time.',
        ].join(' '),
        parameters: INVESTIGATE_WEB_PARAMETERS,
        handler: async (rawArgs) => {
            if (activeRun) {
                return [
                    'investigate_web: another web investigation is already running. Only one is',
                    'allowed at a time so the user retains full control. Wait for it to finish',
                    'and then issue your next investigate_web call.',
                ].join(' ');
            }

            const args = rawArgs as unknown as InvestigateWebArgs;
            const researchId = randomUUID();
            opts.onResearchActive?.(researchId, true);

            const run = (async (): Promise<string> => {
                // Lazy TTL cleanup — runs once per investigation start so disk
                // usage stays bounded even if the SIGINT hook never fired.
                const ttlMs = settings.ttlMinutes * 60_000;
                await deleteResearchChunksOlderThan(Date.now() - ttlMs, opts.repoKey);

                const factory = createWebResearchTools(researchId, settings, opts.repoKey);

                const systemPrompt = buildWebInvestigatorSystemPrompt(settings);
                const taskPrompt = buildWebInvestigatorTaskPrompt(args);

                const { result, events } = await runSubAgentTask({
                    runtime,
                    mcpServers,
                    workingDirectory,
                    systemPrompt,
                    taskPrompt,
                    toolWhitelist: settings.toolWhitelist,
                    additionalLocalTools: factory.tools,
                    resultSchema: buildWebResultSchema(settings.maxEvidenceItems),
                    ...(runtime.contextWindow !== undefined ? { contextWindow: runtime.contextWindow } : {}),
                    ...(opts.chatBridge ? { chatBridge: opts.chatBridge } : {}),
                });

                const stats = factory.stats();

                if (!result) {
                    return JSON.stringify({
                        summary: 'Web investigator did not call submit_result.',
                        evidence: [],
                        confidence: 'low' as const,
                        partial: true,
                        pages_fetched: stats.pagesFetched,
                        pages_failed: stats.pagesFailed,
                        chunks_indexed: stats.chunksIndexed,
                        searches: stats.searches,
                        scrapes: stats.scrapes,
                        note: `Captured event count: ${events.length}.`,
                    }, null, 2);
                }

                const parsed = coerceWebResult(result, stats);

                if (settings.validateExcerpts) {
                    parsed.evidence = await validateWebEvidence(
                        parsed.evidence,
                        researchId,
                        ttlMs,
                        opts.repoKey,
                    );
                }

                if (parsed.evidence.length > settings.maxEvidenceItems) {
                    parsed.evidence = parsed.evidence.slice(0, settings.maxEvidenceItems);
                }

                return JSON.stringify(parsed, null, 2);
            })();

            activeRun = run;

            try {
                return await run;
            } finally {
                activeRun = null;
                // Best-effort row cleanup — TTL is the safety net.
                try {
                    await deleteByResearchIds([researchId], opts.repoKey);
                } catch {
                    // Already swallowed inside helper; redundant guard for safety.
                }
                opts.onResearchActive?.(researchId, false);
            }
        },
    };
}

function buildWebInvestigatorSystemPrompt(settings: WebInvestigatorRuntime['settings']): string {
    return [
        'You are a web research sub-agent. Answer ONE research question with concrete,',
        'evidence-backed findings drawn from the live web. You do NOT modify code. You',
        'do NOT diagnose repository bugs — your scope is external information: library',
        'behaviour, vendor documentation, ecosystem state, recent developments, RFCs.',
        '',
        'You are a small fast model. Bias toward authoritative sources (official docs,',
        'GitHub READMEs, vendor blogs) over content farms. Stop as soon as you can',
        'answer confidently. Do not exhaustively crawl the web.',
        '',
        'Tools (call in roughly this order):',
        `  1. web_search(query, max_results?) — up to ${settings.maxSearches} calls. Returns`,
        '     {title, url, snippet}. CHEAP. Use it to triage which URLs are worth scraping.',
        '     Prefer specific, jargon-rich queries (the language of the docs you want).',
        `  2. web_scrape_and_index({urls, queries, k?}) — up to ${settings.maxScrapes} calls,`,
        `     up to ${settings.urlsPerScrape} URLs per call. Server fetches all URLs in parallel,`,
        '     chunks them, embeds them into your private vector index, then runs vector search',
        '     for each of your supplied queries and returns the most relevant excerpts. You',
        '     never see raw page bodies — only the curated hits. Pass 1–4 focused sub-questions',
        '     in `queries` so the search is sharp.',
        '  3. research_query({query, k?}) — vector search against the chunks YOU already',
        '     indexed. Use it to dig deeper into pages without re-fetching them.',
        '  4. submit_result(...) — call ONCE when you have enough evidence. Then briefly',
        '     acknowledge and stop. Do NOT call any tool after submit_result.',
        '',
        'Workflow:',
        '  - Start with web_search to find candidate URLs. Read titles and snippets carefully',
        '    — they are often enough to discard low-quality sources before scraping.',
        '  - Batch scrapes: pass MANY urls + a few queries to one web_scrape_and_index call,',
        '    rather than scraping URLs one by one.',
        '  - If hits look thin or off-topic, refine with another web_search → scrape cycle.',
        '  - Use research_query to revisit indexed material from a new angle.',
        '',
        'Quality:',
        `  - Cap each evidence excerpt at ${settings.maxExcerptLines} lines.`,
        `  - Cap total evidence at ${settings.maxEvidenceItems} items. Prefer fewer high-signal excerpts.`,
        '  - Every excerpt MUST be copied verbatim from a chunk you retrieved (the tool layer',
        '    will reject hallucinated excerpts).',
        '  - Always include the source URL. Include the section heading when available.',
        '  - `confidence` ∈ {high, medium, low} — honest. If sources are thin, contradictory, or',
        '    out-of-date, return `low` and say so in the summary.',
        '  - `summary` is 2–6 sentences answering the question, citing the evidence.',
        '',
        'If you exhaust your search/scrape budget without enough evidence, submit anyway with',
        'whatever you have and `confidence: "low"` — partial findings are better than none.',
    ].join('\n');
}

function buildWebInvestigatorTaskPrompt(args: InvestigateWebArgs): string {
    const lines: string[] = [];

    if (args.questions.length === 1) {
        lines.push(`Research question: ${args.questions[0]}`);
    } else {
        lines.push(`Research questions (${args.questions.length}) — answer ALL of them in your final synthesis:`);
        for (let i = 0; i < args.questions.length; i++) {
            lines.push(`  ${i + 1}. ${args.questions[i]}`);
        }
        lines.push('');
        lines.push('Plan one search/fetch strategy that covers every question above. The summary you submit must address each one explicitly.');
    }

    if (args.hint) {
        lines.push('', `Hint from caller: ${args.hint}`);
    }

    lines.push('', 'Investigate, then call submit_result with your structured findings.');

    return lines.join('\n');
}

function buildWebResultSchema(maxEvidenceItems: number): Record<string, unknown> {
    return {
        type: 'object',
        properties: {
            summary: {
                type: 'string',
                description: 'A 2–6 sentence answer to the research question, citing the evidence.',
            },
            evidence: {
                type: 'array',
                maxItems: maxEvidenceItems,
                items: {
                    type: 'object',
                    properties: {
                        url: {
                            type: 'string',
                            description: 'Source page URL.',
                        },
                        title: {
                            type: 'string',
                            description: 'Optional source page title.',
                        },
                        section: {
                            type: 'string',
                            description: 'Optional section heading / breadcrumb the excerpt came from.',
                        },
                        excerpt: {
                            type: 'string',
                            description: 'Verbatim excerpt copied from a retrieved chunk.',
                        },
                        why_relevant: {
                            type: 'string',
                            description: '1–2 sentences explaining why this snippet matters.',
                        },
                    },
                    required: ['url', 'excerpt', 'why_relevant'],
                    additionalProperties: false,
                },
            },
            confidence: {
                type: 'string',
                enum: ['high', 'medium', 'low'],
            },
            suggested_next: {
                type: 'string',
                description: 'Optional: what the orchestrator should do or look at next.',
            },
            partial: {
                type: 'boolean',
                description: 'Set to true if the budget was exhausted before fully answering.',
            },
        },
        required: ['summary', 'evidence', 'confidence'],
        additionalProperties: false,
    };
}

export function coerceWebResult(
    raw: Record<string, unknown>,
    stats: WebResearchToolStats,
): WebInvestigationResult {
    const summary = typeof raw['summary'] === 'string' ? raw['summary'] : '';
    const confidence: 'high' | 'medium' | 'low' =
        raw['confidence'] === 'high' || raw['confidence'] === 'medium' || raw['confidence'] === 'low'
            ? raw['confidence']
            : 'low';

    const evidence: WebEvidenceItem[] = Array.isArray(raw['evidence'])
        ? (raw['evidence'] as unknown[]).flatMap((e) => {
            if (!e || typeof e !== 'object') return [];
            const obj = e as Record<string, unknown>;
            const url = typeof obj['url'] === 'string' ? obj['url'] : '';
            const excerpt = typeof obj['excerpt'] === 'string' ? obj['excerpt'] : '';
            const whyRelevant = typeof obj['why_relevant'] === 'string' ? obj['why_relevant'] : '';
            if (!url || !excerpt) return [];

            const title = typeof obj['title'] === 'string' ? obj['title'] : undefined;
            const section = typeof obj['section'] === 'string' ? obj['section'] : undefined;

            const item: WebEvidenceItem = { url, excerpt, why_relevant: whyRelevant };
            if (title !== undefined) item.title = title;
            if (section !== undefined) item.section = section;

            return [item];
        })
        : [];

    const result: WebInvestigationResult = {
        summary,
        evidence,
        confidence,
        pages_fetched: stats.pagesFetched,
        pages_failed: stats.pagesFailed,
        chunks_indexed: stats.chunksIndexed,
        searches: stats.searches,
        scrapes: stats.scrapes,
    };

    if (typeof raw['suggested_next'] === 'string') {
        result.suggested_next = raw['suggested_next'];
    }
    if (raw['partial'] === true) {
        result.partial = true;
    }

    return result;
}

function normaliseForCompare(s: string): string {
    return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Verify each evidence excerpt by retrieving chunks from the same URL and
 * checking that the excerpt is a substring (after whitespace normalisation)
 * of at least one indexed chunk. Failures are kept in the result but tagged.
 */
export async function validateWebEvidence(
    evidence: WebEvidenceItem[],
    researchId: string,
    ttlMs: number,
    repoKey?: string,
): Promise<WebEvidenceItem[]> {
    if (evidence.length === 0) return evidence;

    const validated: WebEvidenceItem[] = [];
    for (const item of evidence) {
        try {
            const vector = await embedOne(item.excerpt);
            const hits = await searchResearchChunks({
                researchId,
                vector,
                k: 8,
                ttlMs,
                ...(repoKey !== undefined ? { repoKey } : {}),
            });

            const needle = normaliseForCompare(item.excerpt);
            const sameUrlHits = hits.filter((h) => h.url === item.url);
            const candidates = sameUrlHits.length > 0 ? sameUrlHits : hits;
            const matched = candidates.some((h) => normaliseForCompare(h.content).includes(needle));

            if (matched) {
                validated.push(item);
            } else {
                validated.push({
                    ...item,
                    why_relevant: `[unverified: excerpt not found in indexed chunks for ${item.url}] ${item.why_relevant}`,
                });
            }
        } catch (e) {
            validated.push({
                ...item,
                why_relevant: `[unverified: validation error: ${e instanceof Error ? e.message : String(e)}] ${item.why_relevant}`,
            });
        }
    }

    return validated;
}
