/**
 * `kra ai memory` — entry point that launches the blessed memory dashboard.
 *
 * The full UI lives in `manageMemoryDashboard.ts`. This file is kept as the
 * stable export referenced by `aiCommands.ts` and `AI/index.ts`.
 */

import { manageMemoryDashboard } from '@/AI/AIAgent/commands/manageMemoryDashboard';

export async function manageMemory(): Promise<void> {
    await manageMemoryDashboard();
}
