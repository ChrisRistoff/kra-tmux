/**
 * BYOK AgentClient — thin factory around OpenAICompatibleSession.
 *
 * One client per (provider, model, key) tuple. createSession() builds and
 * `init()`s a session; each session owns its own MCP client pool.
 */

import type { AgentClient, AgentSession, AgentSessionOptions } from '@/AI/AIAgent/shared/types/agentTypes';
import { OpenAICompatibleSession } from '@/AI/AIAgent/providers/byok/byokSession';

export interface OpenAICompatibleClientOptions {
    baseURL: string;
    apiKey: string;
}

export class OpenAICompatibleClient implements AgentClient {
    private readonly baseURL: string;
    private readonly apiKey: string;
    private sessions: OpenAICompatibleSession[] = [];

    public constructor(options: OpenAICompatibleClientOptions) {
        this.baseURL = options.baseURL;
        this.apiKey = options.apiKey;
    }

    public createSession: AgentClient['createSession'] = async (
        options: AgentSessionOptions
    ): Promise<AgentSession> => {
        const session = new OpenAICompatibleSession({
            sessionOptions: options,
            baseURL: this.baseURL,
            apiKey: this.apiKey,
        });

        await session.init();
        this.sessions.push(session);

        return session;
    };

    public stop: AgentClient['stop'] = async () => {
        await Promise.allSettled(this.sessions.map(async (s) => s.disconnect()));
        this.sessions = [];
    };
    public forceStop: () => Promise<void> = async () => {
        await this.stop();
    };
}
