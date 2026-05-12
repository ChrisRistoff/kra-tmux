import * as fs from 'fs/promises';
import * as nodePath from 'path';
import * as os from 'os';
import { createAgentHistory } from '@/AI/AIAgent/shared/utils/agentHistory';
import { buildCoreMcpServers } from '@/AI/AIAgent/mcp/serverConfig';
import * as conversation from '@/AI/shared/conversation';
import type {
    AgentConversationOptions,
    AgentConversationState,
    AgentPreToolUseHookInput,
    AgentPreToolUseHookOutput,
    AgentPostToolUseHookInput,
    AgentPostToolUseHookOutput,
    LocalTool,
} from '@/AI/AIAgent/shared/types/agentTypes';
import { createInvestigateTool } from '@/AI/AIAgent/shared/subAgents/investigateTool';
import { createInvestigateWebTool } from '@/AI/AIAgent/shared/subAgents/investigateWebTool';
import { createExecuteTool } from '@/AI/AIAgent/shared/subAgents/executeTool';
import { deleteByResearchIds } from '@/AI/AIAgent/shared/memory/researchChunks';
import type { AgentTruncationSettings } from '@/AI/AIAgent/shared/subAgents/types';

// Fallback truncation profiles used when callers don't pass settings (e.g. tests).
// The real defaults live in `subAgents/settings.ts`; these mirror them so the
// behaviour is identical when settings.toml is absent.
const ORCHESTRATOR_TRUNCATION_FALLBACK: AgentTruncationSettings = {
    defaultHead: 4000,
    defaultTail: 4000,
    bashHead: 2000,
    bashTail: 6000,
    neverTruncate: ['semantic_search', 'docs_search', 'recall', 'get_outline'],
};
const SUB_AGENT_TRUNCATION_FALLBACK: AgentTruncationSettings = {
    defaultHead: 8000,
    defaultTail: 8000,
    bashHead: 4000,
    bashTail: 12000,
    neverTruncate: ['semantic_search', 'docs_search', 'recall', 'get_outline'],
};
import { createOrchestratorTranscript } from '@/AI/AIAgent/shared/main/orchestratorTranscript';

import { handleAgentUserInput, handlePreToolUse } from '@/AI/AIAgent/shared/utils/agentToolHook';
import { runMultiRepoIndexingFlow } from '@/AI/AIAgent/shared/main/agentIndexingFlow';
import { setupSessionEventHandlers, updateAgentUi } from '@/AI/AIAgent/shared/utils/agentSessionEvents';
import { formatUserDraftHeader } from '@/AI/shared/utils/conversationUtils/chatHeaders';

async function createAgentChatFile(chatFile: string): Promise<void> {
    const initialContent = `# Copilot Agent Chat

# Type your prompt in the bottom split.
`;
    await fs.writeFile(chatFile, `${initialContent}${formatUserDraftHeader()}`, 'utf8');
}
import { handleSubmit, setupEventHandlers, getErrorMessage } from '@/AI/AIAgent/shared/main/agentPromptActions';
import { selectRepoRoots } from '@/AI/AIAgent/commands/repoSelection';
import { getRepoIdentity } from '@/AI/AIAgent/shared/memory/registry';
import { computeRepoKey } from '@/AI/AIAgent/shared/memory/repoKey';
import type { WatcherHandle } from '@/AI/AIAgent/shared/memory/watcher';
import type { createChatTuiApp } from '@/AI/TUI/chatTuiApp';
import { bootstrapTuiApp } from '@/AI/TUI/host/bootstrapTui';
import { createTuiAgentHost } from '@/AI/TUI/host/agentHost';
import { buildWelcomeBanner } from '@/AI/TUI/widgets/welcomeBanner';
import { createTuiChatHost } from '@/AI/TUI/host/chatHost';
import { createTuiChatPickers } from '@/AI/TUI/host/pickers';
import { wireSharedLeaderKeys } from '@/AI/TUI/host/leaderKeys';
import { getAgentTurnHeaderRenderer } from '@/AI/AIAgent/shared/main/agentTurnHeaders';
import { fileContexts } from '@/AI/shared/utils/conversationUtils/fileContextStore';

const fileContext = conversation;

async function cleanup(state: AgentConversationState): Promise<void> {
    fileContext.clearFileContexts();
    await updateAgentUi(state.host, 'finish_turn');

    const changedCount = state.history.listChangedPaths().length;
    if (changedCount > 0) {
        console.log(`${changedCount} file(s) touched by agent (use <leader>s to browse session history & revert per file).`);
    }

    await fs.rm(state.chatFile, { force: true });
    const reposFile = process.env['KRA_SELECTED_REPO_ROOTS_FILE'];
    if (reposFile) {
        await fs.rm(reposFile, { force: true });
    }
    if (state.watcher) {
        try {
            await state.watcher.close();
        } catch {
            /* best effort */
        }
    }
    await state.session.disconnect();
    await state.client.stop();
}

export async function converseAgent(options: AgentConversationOptions): Promise<void> {
    // Mirror the chat TUI: redirect every console.* write to a log file so
    // the blessed framebuffer keeps exclusive ownership of the terminal.
    // Without this, deprecation warnings / debug logs / our own informational
    // `console.log`s below print AS RAW BYTES on top of the rendered UI,
    // showing as ghost characters that survive scroll/redraw and as terminal
    // background bleed in pane gaps.
    // bootstrapTuiApp() (called below) installs the console redirect on
    // first use so we don't need a separate redirect call here.


    fileContext.clearFileContexts();

    const repoRoots = await selectRepoRoots();
    const cwd = repoRoots[0];
    // Anchor the parent process to the primary repo so anything that resolves
    // workspaceRoot() (indexer, registry, kra-memory db key) sees a real root
    // instead of falling back to process.cwd() (the launch directory, which
    // may contain many sibling repos).
    process.env['WORKING_DIR'] = cwd;

    // Resolve every selected repo's identity + repoKey now so we can:
    //   (a) index each one on startup, and
    //   (b) advertise them to MCP servers via KRA_SEARCH_REPO_KEYS so
    //       semantic_search fans out across all of them.
    const selectedRepos: { root: string; alias: string; repoKey: string }[] = [];
    for (const root of repoRoots) {
        const identity = await getRepoIdentity(root);
        selectedRepos.push({
            root,
            alias: identity.alias,
            repoKey: computeRepoKey(identity.id),
        });
    }
    process.env['KRA_SEARCH_REPO_KEYS'] = selectedRepos.map((r) => r.repoKey).join(',');
    // Newline-separated `alias\troot` lines so MCP servers (which inherit the
    // parent process env directly) know exactly which repos are in scope.
    process.env['KRA_SELECTED_REPO_ROOTS'] = selectedRepos.map((r) => `${r.alias}\t${r.root}`).join('\n');

    // Mirror the same data into a JSON sidecar file. The Neovim @-picker reads
    // this file because Neovim is launched via `tmux split-window … send-keys`,
    // which spawns a fresh shell that does NOT inherit env vars set on this
    // node process after the agent started. We propagate ONLY the file path
    // (short, ASCII) through tmux `-e`, and the picker JSON-decodes it.
    const reposFile = nodePath.join(os.tmpdir(), `kra-agent-repos-${process.pid}.json`);
    await fs.writeFile(reposFile, JSON.stringify(selectedRepos), 'utf8');
    process.env['KRA_SELECTED_REPO_ROOTS_FILE'] = reposFile;

    if (selectedRepos.length > 1) {
        console.log(
            `kra ai agent: ${selectedRepos.length} repos in scope. Primary: ${selectedRepos[0].alias} (${cwd}). ` +
            `Other repos: ${selectedRepos.slice(1).map((r) => `${r.alias} (${r.root})`).join(', ')}.`
        );
    }

    const history = createAgentHistory(selectedRepos.map((r) => r.root));
    const chatFile = `/tmp/kra-agent-chat-${Date.now()}.md`;
    await createAgentChatFile(chatFile);

    // ── TUI bring-up ─────────────────────────────────────────────────────
    // The Neovim front-end is gone. Mount the blessed TUI (same one the
    // chat uses) and build an `AgentHost` that wraps it. Every prior call
    // to `state.nvim.*` has been routed either through the host or through
    // a polymorphic dispatcher (see updateAgentUi / handleAgentUserInput).
    // `state.nvim` survives as a stub for the few deferred features still
    // being ported (proposal review widget, memory browser, etc).
    let onSubmitImpl: (text: string) => void = () => { /* set later */ };
    // Shared bring-up with the chat: identical screen, pickers, ChatHost.
    // The AgentHost composes the same ChatHost, so streaming, approval,
    // file-context, and tool-history behaviour stays in lock-step —
    // changes to the chat's TUI automatically apply here too.
    const { app, pickers, chatHost: chatHostForFileContext } = bootstrapTuiApp({
        title: `agent · ${options.model}`,
        model: options.model,
        onSubmit: (text) => onSubmitImpl(text),
    });
    const host = createTuiAgentHost({ app, pickers, chatHost: chatHostForFileContext });

    {
        const elWidth = (app.transcript.el as unknown as { width: number }).width;
        const cols = (typeof elWidth === 'number' && elWidth > 0)
            ? elWidth
            : (process.stdout.columns ?? 80);
        const bannerLines = buildWelcomeBanner({
            title: '✦  K R A   ·   A I   A G E N T  ✦',
            subtitle: `${options.model}`,
            viewportWidth: cols,
        });
        for (const line of bannerLines) {
            app.transcript.append(line.plain + '\n');
            if (line.styled) {
                app.transcript.setLineStyled(app.transcript.lineCount() - 2, line.styled);
            }
        }
        app.scheduler.schedule();
    }

    // Index every selected repo in parallel. Progress is routed through
    // the host (status bar / notify in chunk #1; full modal in chunk #4).
    await runMultiRepoIndexingFlow(host, selectedRepos.map((r) => r.root));

    // Start the on-save reindex watcher across every selected repo. Deferred
    // until now (rather than in startAgentChat) because we don't know the
    // full set of roots until the user has picked them above.
    let watcher: WatcherHandle | null = null;
    try {
        const { startWatcher } = await import('@/AI/AIAgent/shared/memory/watcher');
        watcher = await startWatcher(
            selectedRepos.map((r) => r.root),
            {
                onEvent: (event) => {
                    if (event.kind === 'remove') {
                        if (event.chunksRemoved > 0) {
                            host.notify(`🗑  ${event.rel} (${event.chunksRemoved} chunks removed)`, 2500);
                        }
                    } else {
                        const { result } = event;
                        if (result.chunksWritten > 0 || result.chunksDeleted > 0) {
                            const parts: string[] = [];
                            if (result.chunksWritten > 0) parts.push(`${result.chunksWritten} chunks`);
                            if (result.chunksDeleted > 0) parts.push(`-${result.chunksDeleted}`);
                            host.notify(`📄 ${event.rel} (${parts.join(', ')})`, 2500);
                        }
                    }
                },
            },
        );
    } catch (err) {
        console.warn(`kra-memory: watcher failed to start: ${err instanceof Error ? err.message : String(err)}`);
    }

    const mcpServers = await buildCoreMcpServers();
    const stateRef: { current?: AgentConversationState } = {};
    const mergedMcpServers = {
        ...mcpServers,
        ...(options.additionalMcpServers ?? {}),
    };
    // Make sure every spawned MCP server inherits the multi-repo env. Some SDK
    // transports (notably the Copilot SDK) do not forward arbitrary parent env
    // vars unless they appear in the per-server `env` field, so plumb the keys
    // we care about explicitly here.
    const inheritedMcpEnv: Record<string, string> = {
        ...Object.fromEntries(
            Object.entries(process.env).filter(([, value]) => typeof value === 'string') as [string, string][],
        ),
    };

    for (const cfg of Object.values(mergedMcpServers)) {
        if (cfg.type === 'local' || cfg.type === 'stdio') {
            cfg.env = { ...inheritedMcpEnv, ...(cfg.env ?? {}) };
        }
    }

    const orchestratorOnPreToolUse = async (input: AgentPreToolUseHookInput): Promise<AgentPreToolUseHookOutput> => {
        if (!stateRef.current) {
            return {
                permissionDecision: 'deny',
                permissionDecisionReason: 'Agent UI is not ready yet.',
            };
        }

        try {
            return await handlePreToolUse(stateRef.current, input);
        } catch (error) {
            await updateAgentUi(stateRef.current.host, 'show_error', [
                `Pre-tool approval failed: ${input.toolName}`,
                getErrorMessage(error),
            ]);

            return {
                permissionDecision: 'deny',
                permissionDecisionReason: `Pre-tool approval failed: ${getErrorMessage(error)}`,
            };
        }
    };

    // Truncation caps for tool results. Two profiles — the orchestrator's own
    // tool results vs. those handed back to a sub-agent (investigator/executor/
    // investigator_web). Sub-agents typically need to digest larger payloads,
    // so the sub-agent profile defaults are looser. Both come from settings.toml.
    const orchestratorTruncation = options.truncation ?? ORCHESTRATOR_TRUNCATION_FALLBACK;
    const subAgentTruncation = options.subAgentTruncation ?? SUB_AGENT_TRUNCATION_FALLBACK;

    const orchestratorOnPostToolUse = async (input: AgentPostToolUseHookInput): Promise<AgentPostToolUseHookOutput> => {
        const isBashLike = ['bash', 'shell', 'execute', 'run_terminal', 'computer'].some(
            (fragment) => input.toolName.toLowerCase().includes(fragment)
        );

        // Sub-agents reach this hook via `bridge.parentOnPostToolUse`, which
        // tags the input with `agentLabel`. Branch on that to apply the right
        // profile so each context can have its own caps.
        const profile = input.agentLabel ? subAgentTruncation : orchestratorTruncation;

        // Structured discovery tools return information-dense JSON whose
        // middle slice is just as load-bearing as the head/tail. Truncating
        // it forces the model to fall back to bash to recover the omitted
        // hits, which defeats the point of having those tools.
        if (profile.neverTruncate.some((name: string) => input.toolName.toLowerCase().includes(name))) {
            return {};
        }

        if (isBashLike && stateRef.current?.pendingBashSnapshot) {
            const snapshot = stateRef.current.pendingBashSnapshot;

            delete (stateRef.current as Partial<AgentConversationState>).pendingBashSnapshot;
            await stateRef.current.history.bashSnapshotAfter(snapshot).catch(() => { /* non-fatal */ });
        }

        const HEAD_CHARS = isBashLike ? profile.bashHead : profile.defaultHead;
        const TAIL_CHARS = isBashLike ? profile.bashTail : profile.defaultTail;
        if (HEAD_CHARS === 0 && TAIL_CHARS === 0) return {};
        const text = input.toolResult.textResultForLlm;
        if (text.length <= HEAD_CHARS + TAIL_CHARS) return {};
        const omitted = text.length - HEAD_CHARS - TAIL_CHARS;

        return {
            modifiedResult: {
                ...input.toolResult,
                textResultForLlm: [
                    text.slice(0, HEAD_CHARS),
                    `\n…[${omitted} chars omitted]…\n`,
                    text.slice(text.length - TAIL_CHARS),
                ].join(''),
            },
        };
    };

    const orchestratorLocalTools: LocalTool[] = [];

    if (options.investigator) {
        orchestratorLocalTools.push(createInvestigateTool({
            runtime: options.investigator,
            mcpServers: mergedMcpServers,
            workingDirectory: cwd,
            chatBridge: {
                getParentState: () => {
                    if (!stateRef.current) {
                        throw new Error('Investigator invoked before orchestrator state was ready');
                    }

                    return stateRef.current;
                },
                agentLabel: 'INVESTIGATOR',
                headerEmoji: '🔍',
                parentOnPreToolUse: orchestratorOnPreToolUse,
                parentOnPostToolUse: orchestratorOnPostToolUse,
            },
        }));
    }

    // Track in-flight `investigate_web` research_ids so SIGINT/exit can purge
    // their rows from the shared LanceDB table even when TTL hasn't kicked in.
    const activeResearchIds = new Set<string>();

    if (options.investigatorWeb) {
        orchestratorLocalTools.push(createInvestigateWebTool({
            runtime: options.investigatorWeb,
            mcpServers: mergedMcpServers,
            workingDirectory: cwd,
            chatBridge: {
                getParentState: () => {
                    if (!stateRef.current) {
                        throw new Error('Web investigator invoked before orchestrator state was ready');
                    }

                    return stateRef.current;
                },
                agentLabel: 'INVESTIGATOR-WEB',
                headerEmoji: '🌐',
                parentOnPreToolUse: orchestratorOnPreToolUse,
                parentOnPostToolUse: orchestratorOnPostToolUse,
            },
            onResearchActive: (researchId, active) => {
                if (active) activeResearchIds.add(researchId);
                else activeResearchIds.delete(researchId);
            },
        }));

        // Best-effort cleanup on shutdown. SIGINT fires for Ctrl-C; `exit`
        // covers normal termination. SIGKILL leaves rows for the next
        // `investigate_web` start (and ultimately the TTL purge) to clean up.
        const purgeActive = (): void => {
            if (activeResearchIds.size === 0) return;
            const ids = Array.from(activeResearchIds);
            activeResearchIds.clear();
            // Fire-and-forget; we can't reliably await on `exit`.
            void deleteByResearchIds(ids).catch(() => undefined);
        };
        process.once('SIGINT', purgeActive);
        process.once('SIGTERM', purgeActive);
        process.once('exit', purgeActive);
    }

    if (options.executor) {
        orchestratorLocalTools.push(createExecuteTool({
            runtime: options.executor,
            mcpServers: mergedMcpServers,
            workingDirectory: cwd,
            chatBridge: {
                getParentState: () => {
                    if (!stateRef.current) {
                        throw new Error('Executor invoked before orchestrator state was ready');
                    }

                    return stateRef.current;
                },
                agentLabel: 'EXECUTOR',
                headerEmoji: '⚙️',
                parentOnPreToolUse: orchestratorOnPreToolUse,
                parentOnPostToolUse: orchestratorOnPostToolUse,
            },
        }));
    }

    const session = await options.client.createSession({
        model: options.model,
        workingDirectory: cwd,
        mcpServers: mergedMcpServers,
        excludedTools: ['str_replace_editor', 'write_file', 'read_file', 'edit', 'view', 'grep', 'glob', 'create', 'apply_patch', 'report_intent', ...(options.provider === 'copilot' ? ['ask_user'] : [])],
        ...(orchestratorLocalTools.length > 0 ? { localTools: orchestratorLocalTools } : {}),
        ...(options.contextWindow !== undefined ? { contextWindow: options.contextWindow } : {}),
        ...(options.modelCapabilities ? { modelCapabilities: options.modelCapabilities } : {}),
        ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
        ...(options.temperature != null ? { temperature: options.temperature } : {}),
        ...(options.dynamicParams ? { dynamicParams: options.dynamicParams } : {}),
        onPreToolUse: orchestratorOnPreToolUse,
        onPostToolUse: orchestratorOnPostToolUse,
        onUserInputRequest: async (request) => handleAgentUserInput(
            host,
            request.question as string,
            request.choices as string[] | undefined,
            (request.allowFreeform as boolean | undefined) ?? true
        ),

        systemMessage: {
            mode: 'append',
            content: buildOrchestratorSystemMessage({
                selectedRepos,
                investigateEnabled: !!options.investigator,
                investigateWebEnabled: !!options.investigatorWeb,
                executeEnabled: !!options.executor,
                isCopilot: options.provider === 'copilot',
            }),
        },
    });


    const state: AgentConversationState = {
        chatFile,
        model: options.model,
        client: options.client,
        session,
        host,
        cwd,
        history,
        isStreaming: false,
        approvalMode: 'strict',
        allowedToolFamilies: new Set<string>(),
        transcript: createOrchestratorTranscript(),
        watcher,
    };
    stateRef.current = state;

    // ── Orchestrator transcript capture ──────────────────────────────────────
    // Listen on the orchestrator session for assistant text / tool calls and
    // mirror them into `state.transcript`. The transcript is later sliced and
    // injected into the executor sub-agent's task prompt (see executeTool.ts)
    // so the executor inherits the orchestrator's prior file reads + findings
    // without re-fetching them.
    const pendingToolCalls = new Map<string, { toolName: string; args: unknown }>();
    let assistantBuffer = '';

    const flushAssistantBuffer = (): void => {
        if (assistantBuffer.length === 0) return;

        state.transcript.appendAssistant(assistantBuffer);
        assistantBuffer = '';
    };

    // Capture only the final reply text (`assistant.message_delta`), NOT the
    // chain-of-thought stream (`assistant.reasoning_delta`). Per Anthropic's
    // guidance, prior thinking blocks are private scratchpad and should not be
    // re-fed as input — they contain false starts and bloat the prompt, and
    // the executor (a fresh model invocation) does its own reasoning anyway.
    session.on('assistant.message_delta', (event) => {
        const delta = (event.data as { deltaContent?: string }).deltaContent;

        if (typeof delta === 'string') {
            assistantBuffer += delta;
        }
    });

    session.on('tool.execution_start', (event) => {
        flushAssistantBuffer();

        const data = event.data as {
            toolCallId: string;
            toolName: string;
            mcpToolName?: string;
            arguments?: unknown;
        };
        // Prefer the bare MCP tool name when available (so suffix-based filters
        // in `buildExecutorTranscript` match cleanly across providers).
        const toolName = data.mcpToolName ?? data.toolName;

        pendingToolCalls.set(data.toolCallId, {
            toolName,
            args: data.arguments,
        });
    });

    session.on('tool.execution_complete', (event) => {
        const data = event.data as {
            toolCallId: string;
            success: boolean;
            result?: { content?: string; detailedContent?: string };
            error?: unknown;
        };
        const pending = pendingToolCalls.get(data.toolCallId);

        pendingToolCalls.delete(data.toolCallId);

        if (!pending) return;

        const result = data.success
            ? (data.result?.detailedContent ?? data.result?.content ?? '')
            : (data.error !== undefined ? String(data.error) : '');

        state.transcript.appendToolCall({
            toolName: pending.toolName,
            args: pending.args,
            result,
            success: data.success,
        });
    });

    session.on('session.idle', () => {
        flushAssistantBuffer();
    });

    try {
        await setupSessionEventHandlers(state);
        await setupEventHandlers(state);

        const executableTools = state.session.listExecutableTools?.() ?? [];
        await updateAgentUi(host, 'set_executable_tools', [executableTools]);

        // Wire the same leader-key surface the chat exposes, plus the
        // agent-only stubs that will become real widgets in chunks #2-#4.
        wireAgentLeaderKeys(app, host, state, pickers, chatHostForFileContext);

        // Render the USER (draft) banner at startup so the user sees
        // their turn waiting from the moment the TUI mounts — same as
        // chat and the legacy nvim flow.
        getAgentTurnHeaderRenderer(app).renderDraftBanner();

        // Route the prompt-pane submit into the agent's send loop.
        onSubmitImpl = (text: string): void => {
            void handleSubmit(state, text).catch((err) => {
                host.showError('Submit failed', err instanceof Error ? err.message : String(err));
                state.isStreaming = false;
            });
        };

        host.notify('ready', 1500);

        let cleaningUp = false;
        const runCleanup = async (): Promise<void> => {
            if (cleaningUp) return;
            cleaningUp = true;
            try { await cleanup(state); } catch { /* swallow */ }
        };
        process.once('SIGINT', () => { void runCleanup(); });
        process.once('SIGTERM', () => { void runCleanup(); });

        // Block here until the user quits the TUI.
        await app.done();
        await runCleanup();
    } catch (error) {
        await cleanup(state);
        throw error;
    }
}

function wireAgentLeaderKeys(
    app: ReturnType<typeof createChatTuiApp>,
    host: ReturnType<typeof createTuiAgentHost>,
    state: AgentConversationState,
    pickers: ReturnType<typeof createTuiChatPickers>,
    chatHost: ReturnType<typeof createTuiChatHost>,
): void {
    const headers = getAgentTurnHeaderRenderer(app);
    const refreshAttachments = (): void => {
        headers.setAttachments(fileContexts.map((c) => {
            if (c.isPartial) {
                const range = c.startLine === c.endLine
                    ? `line ${c.startLine}`
                    : `lines ${c.startLine}-${c.endLine}`;

                return `${c.filePath} (${range})`;
            }

            return c.summary;
        }));
    };
    // Use the SHARED leader-key wiring (same a/r/f/x/h/t items the chat
    // shows) and pass agent-specific extras.
    wireSharedLeaderKeys({
        app, pickers, chatHost, chatFile: state.chatFile,
        title: 'Agent leader (␣)',
        onContextsChanged: refreshAttachments,
        // C-c stops the in-flight agent run (and any spawned sub-agent)
        // — it does NOT quit the app. C-q is the only quit key.
        onCtrlC: () => {
            if (!state.isStreaming) {
                host.notify('nothing to stop — press C-q to quit', 1500);

                return;
            }
            void (async () => {
                if (state.activeSubAgentSession) {
                    try { await state.activeSubAgentSession.abort(); } catch { /* noop */ }
                }
                try { await state.session.abort(); } catch { /* noop */ }
                state.isStreaming = false;
                host.notify('stream stopped', 1500);
            })();
        },
        extraItems: [
            { key: 'm', category: 'Memory',   label: 'Memory browser',  description: 'Browse kra-memory entries (Tab cycles view)', action: () => { void host.openMemoryBrowser('all'); } },
            { key: 's', category: 'History',  label: 'Session history', description: 'Browse every recorded version of every file changed this session', action: () => { void host.openSessionHistory(state.history); } },
            { key: 'i', category: 'Index',    label: 'Index progress',  description: 'Reopen the most recent indexing progress modal',  action: () => host.indexProgress.reopen() },
            { key: 'y', category: 'Approval', label: 'Toggle YOLO',     description: 'Skip approvals for the rest of session',
                action: () => {
                    state.approvalMode = state.approvalMode === 'yolo' ? 'strict' : 'yolo';
                    host.notify(`approval mode: ${state.approvalMode}`, 2000);
                } },
            { key: 'P', category: 'Approval', label: 'Reset approvals', description: 'Forget remembered tool-family approvals',
                action: () => {
                    state.allowedToolFamilies.clear();
                    state.approvalMode = 'strict';
                    host.notify('approvals reset', 2000);
                } },
        ],
    });
}

interface OrchestratorSystemMessageOpts {
    investigateEnabled: boolean;
    investigateWebEnabled?: boolean;
    executeEnabled: boolean;
    isCopilot?: boolean;
    selectedRepos?: { root: string; alias: string; repoKey: string }[];
}

export function buildOrchestratorSystemMessage(opts: OrchestratorSystemMessageOpts): string {
    const { investigateEnabled, executeEnabled } = opts;
    const anySubAgent = investigateEnabled || executeEnabled;
    const sections: string[] = [];

    if (opts.isCopilot) {
        sections.push(TURN_COMPLETION_BLOCK);
    }

    sections.push(buildWorkspaceBlock(opts.selectedRepos));

    if (anySubAgent) {
        sections.push(buildDelegationBlock(opts));
    }

    sections.push(buildReadingCodeBlock(anySubAgent));
    sections.push(buildSurgicalEditsBlock(executeEnabled));
    sections.push(CREATING_FILES_BLOCK);
    sections.push(buildLongTermMemoryBlock(investigateEnabled));

    if (opts.isCopilot) {
        sections.push('Reminder: Always call ask_kra before ending your turn.');
    }

    return sections.join('\n\n');
}

const TURN_COMPLETION_BLOCK = `<turn_completion priority="critical">
End every turn by calling \`ask_kra\` with a concise summary and 2–4 concrete choices — whether you finished, are blocked, or need clarification. Never end with plain text.
</turn_completion>`;

function buildWorkspaceBlock(selectedRepos?: { root: string; alias: string }[]): string {
    const lines: string[] = ['<workspace>'];
    lines.push('Every file edit lands in the real repository only after the user reviews and approves the per-tool diff in the TUI. Approved edits are committed immediately; the user can revert any prior version via the session history browser (<leader>s).');

    if (selectedRepos && selectedRepos.length > 1) {
        lines.push('');
        lines.push(`**Multi-repo workspace** — ${selectedRepos.length} repos are in scope:`);
        for (const repo of selectedRepos) {
            const isPrimary = repo.root === selectedRepos[0].root;
            lines.push(`  - \`${repo.alias}\` → ${repo.root}${isPrimary ? ' (primary)' : ''}`);
        }
        lines.push('');
        lines.push('**All tools work across every listed repo.** Use absolute paths to address files outside the primary repo:');
        lines.push('  - `semantic_search` automatically fans out across every listed repo; results are absolute paths so you can tell them apart.');
        lines.push('  - `read_lines` / `get_outline` / `read_function` / `anchor_edit` / `create_file` / `lsp_query` / `search` accept absolute paths under any selected repo. Relative paths resolve against the **primary** repo.');
        lines.push('  - `bash` accepts an optional `cwd` argument (an absolute path under any selected repo, OR a repo alias like `' + selectedRepos[1].alias + '`). Without `cwd`, it runs in the primary repo.');
        lines.push('  - User-provided file contexts (the `@` picker) span all selected repos and arrive as absolute paths.');
    }

    lines.push('</workspace>');

    return lines.join('\n');
}

const CREATING_FILES_BLOCK = `<creating_files>
Use \`create_file\` for new files only. It refuses if the file already exists. For existing files, use the \`edit\` tool.

Do NOT use bash/shell for file mutations (no \`cat > file\`, \`echo ... >\`, \`sed -i\`, \`tee\`, heredocs writing files, etc.). Use \`anchor_edit\` for in-place changes. If you need to almost completely rewrite a file, delete it via bash \`rm\` and then \`create_file\` with the new content.

Project-wide LSP diagnostics are auto-appended to every \`edit\`/\`create_file\` result for the touched language. Do NOT run \`tsc\`, \`tsc --noEmit\`, \`npm run build\`, \`cargo check\`, \`go build\`, or similar type-check/build commands just to surface errors — that work has already been done. Only invoke build/test commands when you actually need their side effects (running tests, producing artifacts).
</creating_files>`;

function buildDelegationBlock(opts: OrchestratorSystemMessageOpts): string {
    const lines: string[] = ['<delegation priority="high">'];

    lines.push('Sub-agents available — use them to keep your context lean:');
    lines.push('');

    if (opts.investigateEnabled) {
        lines.push('- `investigate` — LOCATION/FLOW questions only ("where is X?", "how does Y flow?"). NOT for diagnosis, root-cause, bug-hunting, or design judgement — those are YOUR job. Use it to gather information about how a system works; reason about the issue yourself. Pass known context via `hint`.');
    }

    if (opts.investigateWebEnabled === true) {
        lines.push('- `investigate_web` — web research. For questions whose answer lives outside this repo: library/SDK behaviour, current ecosystem state, vendor docs, RFCs, recent developments. Sub-agent searches, scrapes authoritative pages, and returns curated `{summary, evidence, confidence}` excerpts. NOT for repository code questions — use `investigate` for those. Pass known steering (canonical URLs, version, user context) via `hint`.');
        lines.push('  - **The `questions` parameter is an array — use it.** List ALL related sub-questions in the same `questions[]` on ONE call. "Related" = same library, vendor, docs source, or topic. The sub-agent answers them all from one round of fetches.');
        lines.push('  - **Before calling, check yourself:** "Does this call\'s scope overlap with one I already made (or am about to make) this turn?" If yes → STOP, add the new questions to the existing call\'s array (or merge before issuing). Splitting wastes a full search + fetch + index + synthesis cycle and fragments context.');
        lines.push('  - Separate calls are ONLY appropriate when topics are genuinely unrelated (different library, different vendor, no shared docs source). When in doubt, bundle.');
    }

    if (opts.executeEnabled) {
        const transcriptNote = opts.investigateEnabled
            ? 'a transcript of your prior `investigate` calls, file reads, and reasoning since the last execute'
            : 'a transcript of your prior file reads and reasoning since the last execute';

        lines.push(`- \`execute\` — concrete multi-step work (refactor, feature, multi-file edit). Returns ONLY a curated event log + summary; raw tool traffic stays out of your context. Do NOT copy findings/file contents into \`plan\` — the executor automatically receives ${transcriptNote}.`);
        lines.push('  - If executor returns `status: needs_decision`, it hit a real design crossroad. Present the `decisionPoint.question` (and `options[]` if any) to the user via `ask_kra` — do NOT autonomously decide. Once the user picks, re-issue `execute` with an updated plan.');
        lines.push('  - `needs_replan` and `blocked` also allow re-issue with an updated plan.');
        lines.push('  - **Session continuation**: If the result includes a `sessionId`, pass it back as `sessionId` on the re-issued `execute` call. The executor then continues from its stored conversation rather than starting fresh — you do NOT need to repeat prior context in the new plan.');
    }

    lines.push('');
    lines.push('Do it yourself only for: a single trivial edit, or work needing orchestrator-grade reasoning at every step.');

    const concurrencyParts: string[] = [];
    if (opts.investigateEnabled) concurrencyParts.push('ONE investigate');
    if (opts.investigateWebEnabled === true) concurrencyParts.push('ONE investigate_web');
    if (opts.executeEnabled) concurrencyParts.push('ONE execute');
    if (concurrencyParts.length > 0) {
        lines.push(`Only ${concurrencyParts.join(' and ')} can run at a time.`);
    }

    lines.push('</delegation>');

    return lines.join('\n');
}

function buildReadingCodeBlock(delegateFirst: boolean): string {
    const preamble = delegateFirst
        ? 'Before raw reads, check if delegation (see <delegation>) fits. The rules below apply when you read directly.\n\n'
        : '';

    return `<reading_code>
${preamble}**Default: get_outline first to find the smallest range; then read_lines on that range.**

  - Files ≤150 lines: just read whole.
  - Known exact range ≤150 lines: read_lines directly.
  - Otherwise: get_outline → read_lines on the targeted range.
  - read_lines bounces requests >200 lines on files with a meaningful outline (use a tighter range, not multiple calls). Unstructured files (txt/csv/log/plain md) are never gated; 500-line hard cap.

Searching: use \`kra-file-context:search\` (grep/glob disabled). \`name_pattern\` for files, \`content_pattern\` for content.
</reading_code>`;
}

function buildSurgicalEditsBlock(executeEnabled: boolean): string {
    const preamble = executeEnabled
        ? 'These rules apply when you edit directly. For multi-file or multi-step edits, prefer delegating to `execute` (see <delegation>).\n\n'
        : '';

    return `<surgical_edits>
${preamble}**Edit ONLY the code that must change. Anchor each edit to surrounding content.**

The \`edit\` tool is anchor-based. Each entry in \`edits\` has:
  - \`op\`: "replace" | "insert" | "delete"
  - \`anchor\`: 1+ contiguous lines from the CURRENT file, VERBATIM (whitespace included). Must match EXACTLY ONCE. For ranges, anchor = first line.
  - \`end_anchor\` (replace/delete only, optional): last line of region. Both ends content-verified; everything between replaced.
  - \`position\` (insert only): "before" | "after". Default "after".
  - \`content\`: required for replace/insert. Do NOT include unchanged context.

If an anchor is ambiguous (e.g. \`}\`, \`return null;\`), widen UPWARD/DOWNWARD until unique — the error tells you how many places matched. Whitespace-trimmed fallback is auto-attempted; tool reports if used.

Multi-edit: pass several entries in one call. Anchors resolve against ORIGINAL file in parallel; engine applies bottom-to-top. Overlapping regions rejected. Order doesn't matter. Prefer one batched call over sequential calls to the same file.

**Examples:**

  Single line:
    { op: "replace", anchor: "const TIMEOUT_MS = 5000;", content: "const TIMEOUT_MS = 30000;" }

  Multi-line region with end_anchor:
    { op: "replace",
      anchor: "function oldImpl() {",
      end_anchor: "} // oldImpl",
      content: "function newImpl() {\n    return doIt();\n}" }

  Insert after an import:
    { op: "insert", anchor: "import { foo } from './foo';", position: "after",
      content: "import { bar } from './bar';" }

The anchor IS the contract — only matched region changes. Pick tight unique anchors; widen ONLY to disambiguate.

**Minimum-footprint rule:** the lines you replace must be approximately the lines that actually change. If only 2 lines change, only ~2 lines should be in \`anchor\` + \`content\` — not 20, not 200, not the whole function or file. Do NOT pad the anchor or content with surrounding unchanged code as a "buffer". If a small edit is rejected, read the reason carefully, and retry with a *different* small anchor (or several small edits batched in one call); never widen scope to the whole block/file as a workaround. Whole-file rewrites belong to \`rm\` + \`create_file\`, not \`anchor_edit\`.
</surgical_edits>`;
}

function buildLongTermMemoryBlock(investigateEnabled: boolean): string {
    const discoveryRule = investigateEnabled
        ? `**Discovery first:** for any new non-trivial conceptual question (bug, feature, unfamiliar request), start with \`investigate\`. Use \`semantic_search\` directly only for memory-only lookups or quick scoped scans. Skip kickoff only when the user gave an exact file/symbol/path/string, or for tiny local edits. Use \`search\` for exact symbol/string/path lookups.`
        : `**Discovery first:** for any new non-trivial conceptual question, start with \`semantic_search({ query, scope: 'both', memoryKind: 'findings' })\`. Skip only when the user gave an exact file/symbol/path/string, or for tiny local edits. Use \`search\` for exact symbol/string/path lookups. Don't repeat broad semantic queries — if the first pass is weak, switch to targeted \`search\` / \`lsp_query\`.`;

    return `<long_term_memory priority="high">
Long-term memory (kra-memory) is your persistent vector store across sessions. TWO tables — always pass the correct \`kind\`:

**Findings** — \`kind\` ∈ { \`bug-fix\`, \`gotcha\`, \`decision\`, \`investigation\`, \`note\` }. Things you discover that a future session needs.
  - \`bug-fix\` root cause + fix; \`gotcha\` repo-specific trap; \`decision\` design choice + rationale; \`investigation\` reusable research result; \`note\` anything else.

**Revisits** — \`kind: 'revisit'\`. Deferred ideas. Status \`open\`/\`resolved\`/\`dismissed\`. Close via \`update_memory\`.

**Write proactively** after: fixing a non-obvious bug, hitting a gotcha, making a non-trivial design choice, completing a reusable investigation, or when the user defers an idea. Include enough detail in \`body\` that a future session can act without re-investigating. Always set \`paths\` when relevant.

${discoveryRule}

**Reading memory:**
- \`recall({ kind, query?, tagsAny?, status? })\` — \`kind\` required. With \`query\` runs vector search; without, list mode (newest first). Use mainly for listing/filtering revisits.
- \`semantic_search({ query, scope?, memoryKind?, pathGlob? })\` — conceptual search. \`scope\` is \`code\` (default) / \`memory\` / \`both\`. Preferred first-step discovery tool.
- \`edit_memory\` to refine in place (re-embeds on title/body change) instead of creating duplicates.
</long_term_memory>`;
}































