import * as git from "@/git/index";
import { GitCommands } from "@/commandsMaps/types/commandTypes";

export const gitCommands: GitCommands = {
    'restore': {
        run: git.restoreFile,
        description: 'Restore tracked files back to the current git state',
        details: 'Recover tracked working-tree changes after reviewing the affected file or files. Use it when you want to discard local tracked edits and return to the current checkout state.',
        highlights: [
            'Searchable list of modified tracked files.',
            'Supports single-file restore or restoring everything at once.',
            'Keeps the flow focused on safe recovery instead of raw git commands.',
        ],
    },
    'cache-untracked': {
        run: git.saveUntracked,
        description: 'Store an untracked file in the workflow cache',
        details: 'Preserve an untracked file outside git before you switch branches, reset, or clean the repo. The file is stored in kra-managed cache storage so you can bring it back later.',
        highlights: [
            'Useful for temporary work that is not committed yet.',
            'Designed to pair with retrieve-untracked for round-trip recovery.',
            'Lets you protect untracked files without forcing a git add or stash.',
        ],
    },
    'retrieve-untracked': {
        run: git.loadUntracked,
        description: 'Restore a previously cached untracked file',
        details: 'Browse files you previously saved with cache-untracked and write the selected file back into the working tree.',
        highlights: [
            'Restores from the local kra cache rather than from git history.',
            'Useful after branch switches, resets, or cleanup workflows.',
            'Completes the untracked-file preservation flow started by cache-untracked.',
        ],
    },
    'hard-reset': {
        run: git.hardReset,
        description: 'Reset the repository to a clean HEAD state',
        details: 'Runs the destructive cleanup flow for the current repository so tracked changes are discarded and the branch is brought back to a clean checked-out state.',
        highlights: [
            'Intended for deliberate cleanup, not everyday editing.',
            'Useful when local tracked changes should be thrown away completely.',
            'Keeps the dangerous reset flow behind an explicit menu action.',
        ],
    },
    'log': {
        run: git.getGitLog,
        description: 'Open the full multi-pane commit history dashboard',
        details: 'The canonical shared git dashboard: recent commits on the left, with commit details, changed files, and graph context on the right.',
        highlights: [
            'Optimized for reading recent history and investigating what changed.',
            'Shows meaningful context beside the commit list instead of a flat picker.',
            'Acts as the interaction baseline for the shared dashboard shell.',
        ],
    },
    'stash': {
        run: git.applyOrDropStash,
        description: 'Browse stashes and choose whether to apply or drop them',
        details: 'Inspect stash entries, review their context, then choose the next action from the shared picker flow instead of remembering stash IDs manually.',
        highlights: [
            'Searchable stash selection.',
            'Action picker explains the difference between apply and drop.',
            'Good for selective stash recovery or cleanup.',
        ],
    },
    'stash-drop-multiple': {
        run: git.dropMultipleStashes,
        description: 'Drop several stashes in sequence',
        details: 'Fast cleanup flow for stash-heavy repos. After each deletion the list refreshes so you can keep dropping entries until you are done.',
        highlights: [
            'Built specifically for repeated stash cleanup.',
            'Avoids rerunning the command after every single deletion.',
            'Keeps the stash list live as items disappear.',
        ],
    },
    'conflict-handle': {
        run: git.handleConflicts,
        description: 'Inspect conflicted files and resolve merge markers',
        details: 'Guide the merge-conflict workflow from a file list into the resolution view, then verify whether conflict markers still remain after editing.',
        highlights: [
            'Focuses on files currently in conflict.',
            'Designed for merge-resolution work rather than generic diffs.',
            'Helps you iterate until conflict markers are actually gone.',
        ],
    },
    'view-changed': {
        run: git.handleViewChanged,
        description: 'Review modified files in the repository',
        details: 'Open a changed-file browser for the current repo so you can inspect diffs and file state before deciding whether to keep editing, restore, or commit.',
        highlights: [
            'Useful as a quick review pass before commit or cleanup.',
            'Surfaces changed files through the shared picker flow.',
            'Complements restore and conflict-handle with a broader repo view.',
        ],
    },
    'open-pr': {
        run: git.openRemoteUrl,
        description: 'Open the current branch or pull request URL remotely',
        details: 'Resolve the relevant remote URL for the current branch and open the branch, repository, or PR target in the browser.',
        highlights: [
            'Handy when you need the remote branch or PR page immediately.',
            'Keeps repository hosting lookups inside the git command group.',
            'Removes the need to manually build or copy remote URLs.',
        ],
    },
    'create-branch': {
        run: git.createBranch,
        description: 'Create a new branch from a selected base branch',
        details: 'Step through base-branch selection and branch creation from an interactive flow instead of typing the sequence manually.',
        highlights: [
            'Choose the starting branch before creating the new one.',
            'Fits the same shared-menu style as checkout and log.',
            'Good for keeping branch creation consistent across repos.',
        ],
    },
    'checkout': {
        run: git.checkoutBranch,
        description: 'Switch branches through the shared multi-pane picker',
        details: 'Shared branch-switching flow with colored branch rows, recent activity context, and commit information for the highlighted branch before you switch.',
        highlights: [
            'Prioritizes recent branches for faster navigation.',
            'Shows branch context beside the list instead of a bare one-column picker.',
            'Keeps branch switching aligned with the git log dashboard feel.',
        ],
    },
    'reflog': {
        run: git.browseReflog,
        description: 'Browse the git reflog with commit context',
        details: 'Inspect HEAD movement (checkouts, resets, commits, rebases) so you can recover lost work or understand recent history changes. Each entry shows a stat summary in the side panel.',
        highlights: [
            'Lists reflog entries with relative dates.',
            'Side panel shows the commit stat for the highlighted entry.',
            'Useful for finding commits orphaned by reset or rebase.',
        ],
    },
};