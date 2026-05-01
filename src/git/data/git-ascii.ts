export const gitAscii = `
                                   ______               _____            _________
                                 .' ___  |             |_   _|          |  _   _  |
                                / .'   \\_|               | |            |_/ | | \\_|
                                | |    ____              | |                | |
                                \\ '.___]  _|            _| |_              _| |_ 
                                 '._____.'             |_____|            |_____|

                                  _       _                       _   _
                                 (_)     | |                     | | (_)
                                  _ _ __ | |_ ___  __ _ _ __ __ _| |_ _  ___  _ __
                                 | | '_ \\| __/ _ \\/ _' | '__/ _' | __| |/ _ \\| '_ \\
                                 | | | | | ||  __/ (_| | | | (_| | |_| | (_) | | | |
                                 |_|_| |_|\\__\\___|\\__, |_|  \\__,_|\\__|_|\\___/|_| |_|
                                                   __/ |
                                                  |___/

            +------------------------+--------------------------------------------------------------------------------+
            | Command                | Description                                                                    |
            +------------------------+--------------------------------------------------------------------------------+
            | restore                | ♻️  Restore tracked files after reviewing what changed.                         |
            |------------------------|--------------------------------------------------------------------------------|
            | cache-untracked        | 📦  Save an untracked file into the kra cache before switching or cleanup work. |
            |------------------------|--------------------------------------------------------------------------------|
            | retrieve-untracked     | 🔄  Restore a cached untracked file back into the working tree.                 |
            |------------------------|--------------------------------------------------------------------------------|
            | hard-reset             | 🧹  Discard tracked changes and return the repo to a clean checked-out state.   |
            |------------------------|--------------------------------------------------------------------------------|
            | log                    | 📜  Open the shared multi-pane commit history dashboard.                        |
            |------------------------|--------------------------------------------------------------------------------|
            | stash                  | 💼  Browse stashes and choose whether to apply or drop the selected entry.      |
            |------------------------|--------------------------------------------------------------------------------|
            | stash-drop-multiple    | 🗑️  Repeatedly drop stash entries from a live-updating cleanup list.            |
            |------------------------|--------------------------------------------------------------------------------|
            | conflict-handle        | ⚔️  Work through conflicted files and merge-marker cleanup.                     |
            |------------------------|--------------------------------------------------------------------------------|
            | open-pr                | 🔗  Open the current branch or PR target in the browser.                        |
            |------------------------|--------------------------------------------------------------------------------|
            | view-changed           | 🔍  Inspect changed files and diffs before committing or restoring.             |
            |------------------------|--------------------------------------------------------------------------------|
            | create-branch          | 🌿  Pick a base branch, then create the new branch from an interactive flow.    |
            |------------------------|--------------------------------------------------------------------------------|
            | checkout               | ⏳  Switch branches with recent activity and commit context beside the list.    |
            |------------------------|--------------------------------------------------------------------------------|
            | reflog                 | 🧭  Browse the reflog in the same multi-pane dashboard as git log.              |
            +------------------------+--------------------------------------------------------------------------------+

            Use: kra git <command>
`;