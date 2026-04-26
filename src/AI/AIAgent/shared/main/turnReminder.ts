/**
 * Cross-provider turn reminder. Inject after every user prompt (or as the
 * first hint of every assistant turn) to keep the agent disciplined about
 * calling `confirm_task_complete` before ending its turn.
 *
 * Lives in `shared/` so both Copilot and BYOK providers reference the same
 * string — no duplication, no drift.
 */
export const TURN_REMINDER =
    'REMINDER: Call confirm_task_complete before ending your turn — whether you are done, need clarification, or want to ask the user anything.';
