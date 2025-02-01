export const UNTRACKED_CONFIG = {
    pathInfoFileName: 'pathInfo',
    untrackedFilesFolderName: 'untracked'
} as const;

export const GIT_COMMANDS = {
    GET_BRANCH: 'git rev-parse --abbrev-ref HEAD',
    GET_TOP_LEVEL: 'git rev-parse --show-toplevel',
    GET_UNTRACKED: 'git ls-files --others --exclude-standard',
    GET_MODIFIED: "git status --porcelain | awk '/^[ MARC]/{print $2}'",
    GET_CONFLICTS: 'git diff --name-only --diff-filter=U',
    GET_STASHES: 'git stash list --format="%s"',
    GET_REMOTE_BRANCHES: 'git branch -r',
} as const; 