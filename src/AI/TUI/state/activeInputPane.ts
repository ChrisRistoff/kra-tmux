/**
 * Tracks which `PromptPane`-like input is currently the "active" one
 * for purposes of leader-key suppression.
 *
 * The screen-level <Space> handler that opens the which-key popup must
 * NOT fire while the user is typing inside an input pane in INSERT
 * mode (otherwise space-as-a-character is impossible). The main prompt
 * pane is always installed; modals (e.g. `freeformInputModal`) push
 * themselves on while open and pop on close, so the leader handler
 * always asks the *topmost* active input pane whether to suppress.
 */

export interface ActiveInputPane {
    /** The blessed element that should own focus when this pane is active. */
    el: { /* opaque to the registry */ } & object;
    /** Returns `true` if leader keys (space) should be suppressed. */
    isInsert: () => boolean;
    /**
     * Optional per-pane which-key items. When provided, pressing space
     * while this pane owns focus & is in NORMAL mode opens a which-key
     * popup with THESE items instead of the global one. The pane itself
     * is responsible for displaying the popup; the screen-level handler
     * just delegates by calling `openLeader()`.
     *
     * Use this to give widgets (e.g. the diff review modal) their own
     * leader chords without leaking the global which-key bindings.
     */
    openLeader?: () => void;
}

const stack: ActiveInputPane[] = [];

export function pushActiveInputPane(pane: ActiveInputPane): () => void {
    stack.push(pane);
    let released = false;

    return () => {
        if (released) return;
        released = true;
        const idx = stack.lastIndexOf(pane);
        if (idx >= 0) stack.splice(idx, 1);
    };
}

export function topActiveInputPane(): ActiveInputPane | undefined {
    return stack.length > 0 ? stack[stack.length - 1] : undefined;
}
