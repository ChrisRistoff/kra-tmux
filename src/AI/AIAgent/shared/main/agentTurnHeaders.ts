/**
 * Tiny per-app singleton wrapping the shared {@link createTurnHeaderRenderer}.
 *
 * `agentSessionEvents.session.idle` and `agentPromptActions.handleSubmit` both
 * need to drive the same renderer (one writes the user/assistant headers,
 * the other writes the "USER (draft)" placeholder when the turn ends). We
 * key on the ChatTuiApp instance so every fresh agent run gets a fresh
 * renderer state.
 */

import type { ChatTuiApp } from '@/AI/TUI/chatTuiApp';
import {
    createTurnHeaderRenderer,
    type TurnHeaderRenderer,
} from '@/AI/TUI/host/turnHeaders';

const cache = new WeakMap<ChatTuiApp, TurnHeaderRenderer>();

export function getAgentTurnHeaderRenderer(app: ChatTuiApp): TurnHeaderRenderer {
    let r = cache.get(app);
    if (!r) {
        r = createTurnHeaderRenderer(app);
        cache.set(app, r);
    }

    return r;
}
