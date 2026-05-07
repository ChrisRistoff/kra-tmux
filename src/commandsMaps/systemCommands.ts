import * as systemGrepDashboard from "@/system/commands/systemGrepDashboard";
import * as scripts from "@/system/commands/scripts/scriptsDashboard";
import * as systemProcessManager from "@/system/commands/systemProcessManager";
import * as diskUsageDashboard from "@/system/commands/diskUsageDashboard";
import { SystemCommands } from "@/commandsMaps/types/commandTypes";

export const systemCommands: SystemCommands = {
    'grep': {
        run: systemGrepDashboard.openGrepDashboard,
        description: 'Search for files, directories, or content and act on results',
        details: 'Full dashboard: search by file name, directory name, or file content. Navigate results, preview files, open in Neovim, batch-delete, copy paths.',
        highlights: [
            'Three modes: files (f), dirs (d), content grep (c).',
            'Preview file content or matching lines instantly on selection.',
            'Batch-select with space and bulk-delete with X.',
        ],
    },
    'scripts': {
        run: scripts.openScriptsDashboard,
        description: 'Browse, run, edit, and manage repository automation scripts',
        details: 'Full TUI dashboard for repo automation scripts. Filter by name, preview content, run with sh, open in Neovim, create new .sh scripts (shebang added automatically), delete with confirmation, and yank script paths to clipboard.',
        highlights: [
            'Run a script with enter · edit with e · create new with n.',
            'Press D to delete (with confirmation) or y to copy path.',
            'Filter scripts by name with s or / and refresh with r.',
        ],
    },
    'process-manager': {
        run: systemProcessManager.openProcessManager,
        description: 'Browse and kill OS processes interactively',
        details: 'Open a multi-pane TUI dashboard showing all running processes with stats. Search by PID, user, or command name. Send SIGTERM or SIGKILL to selected processes with confirmation.',
        highlights: [
            'Interactive process inspection with full details on demand.',
            'Kill processes safely with y/n confirmation prompts.',
            'Refresh the process list with r without losing your current selection.',
        ],
    },
    'disk-usage': {
        run: diskUsageDashboard.openDiskUsageDashboard,
        description: 'du-style disk usage explorer with delete and inline tree expansion',
        details: 'Multi-pane TUI rooted at the current directory. Lists children sorted by size with % of parent, recursively scans directory sizes in the background, and shows a details pane, an inline children/preview pane, and a top-10 panel for the active root. Descend into a directory with enter, expand inline with e, multi-select with space, and permanently delete the selection with X (confirmed).',
        highlights: [
            'Background recursive size scans — list is responsive while sizes fill in.',
            'Inline tree expansion (e or l) and descend (enter) / ascend (-) navigation.',
            'Multi-select with space + bulk delete with X (confirm + size summary).',
            'Sort cycle (s): size↓ / size↑ / name / mtime / item count.',
            'Open files in nvim (o on file) or reveal directories in Finder/xdg-open (o on dir).',
        ],
    },
};