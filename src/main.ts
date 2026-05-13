#!/usr/bin/env node

import { aiAscii } from '@/AI/shared/data/ai-ascii';
import { pickMenuOption, resolveCommandSelection } from '@/commandsMaps/commandMenu';
import { Command, CommandType, MenuOption } from '@/commandsMaps/types/commandTypes';
import { workflowAscii } from '@/data/workflow-ascii';
import { gitAscii } from '@/git/data/git-ascii';
import { getAsciiHelp, isHelpFlag } from '@/utils/cliHelp';
import { runInstall, isInstalled } from '@/setup/install';
import { sysAscii } from '@/system/data/sys-ascii';
import { tmuxAscii } from '@/tmux/data/tmux-ascii';
import { UserCancelled } from '@/UI/menuChain';

const commandTypeOptions: ReadonlyArray<MenuOption<CommandType>> = [
    {
        name: 'git',
        description: 'Git history, recovery, stash, checkout, and branch workflows',
        details: 'Repository navigation and recovery tools built around the shared multi-pane menus. This is the command group for day-to-day branch work, diff inspection, stash handling, and history browsing.',
        highlights: [
            'Open the git log dashboard with commit details, files, and graph context.',
            'Switch branches, create branches, restore files, and inspect changed work.',
            'Handle stashes, conflicts, and remote PR or branch links from one menu.',
        ],
    },
    {
        name: 'tmux',
        description: 'Save, restore, inspect, and manage tmux server state',
        details: 'Tmux persistence and recovery tools for the full server, not just one session. Use this group when you want to snapshot your workspace, restore it later, inspect what is running now, or manage saved layouts.',
        highlights: [
            'Save sessions, windows, panes, paths, and editor state into a reusable file.',
            'Reload a saved server layout and restore the working directories it captured.',
            'Browse saved session files in the management dashboard and clean up old ones.',
        ],
    },
    {
        name: 'ai',
        description: 'AI chat, agent, indexing, and quota tools',
        details: 'Everything around the interactive AI workflows lives here: direct chats, autonomous agent sessions, saved chat management, indexing, and quota visibility.',
        highlights: [
            'Start Neovim chat sessions with streaming, file context, and web tools.',
            'Launch the agent workflow with provider picking, approvals, diff review, and MCP tools.',
            'Manage saved chats and usage dashboards from shared menus.',
        ],
    },
    {
        name: 'memory',
        description: 'Persistent memory, docs indexing, and semantic search dashboard',
        details: 'Unified kra-memory dashboard for findings/revisits, indexed repositories, docs sources, and search across code, memory, and docs.',
        highlights: [
            'Browse and edit findings and revisits.',
            'Manage indexed repositories and trigger re-indexing.',
            'Control docs crawling and run semantic search in one place.',
        ],
    },
    {
        name: 'notes',
        description: 'Markdown note-taking app (nvim + render-markdown + telescope)',
        details: 'Open the bundled markdown note app powered by nvim with a self-contained config. Notes live under ~/.kra/notes/ with category sub-directories. In-buffer markdown render, fuzzy file picker, link following, backlinks, and quick-insert keymaps under <leader> (space).',
        highlights: [
            'In-buffer markdown rendering and Telescope picker out of the box.',
            'Sub-directory categories (e.g. work/idea-x), wiki-style [[link]] follow, and backlinks.',
            'Quick-insert keymaps for tasks, dates, headings, code blocks, lists, and links.',
        ],
    },
    {
        name: 'sys',
        description: 'System cleanup and automation-script utilities',
        details: 'Operational helpers for cleaning up files or directories and running local automation scripts. This group stays focused on filesystem maintenance and repo-specific scripted workflows.',
        highlights: [
            'Search for files by name and delete only the ones you explicitly choose.',
            'Do the same for directories when you need interactive cleanup of generated folders.',
            'Browse automation scripts from the repo and run them through the shared picker flow.',
        ],
    },
    {
        name: 'settings',
        description: 'Open the interactive settings dashboard',
        details: 'Shared dashboard for browsing and editing the workflow settings file. It is the main entry point for changing runtime behavior without hand-editing TOML.',
        highlights: [
            'Navigate settings by section instead of editing the whole file manually.',
            'Update values, reset entries, and inspect generated TOML previews before saving.',
            'Keep settings changes inside the same shared dashboard shell used by the rest of the menus.',
        ],
    },
];

const main = async (): Promise<void> => {
    const args = process.argv.slice(2);
    const initialCommandType = args[0];

    // Stage 1 POC short-circuit: launch the chat blessed TUI without touching
    // the install / menu / settings pipeline. Removed once Stage 5 wires the
    // real chat spawn path through this entrypoint.
    if (initialCommandType === '--tui-chat-poc') {
        const { runChatTuiPoc } = await import('@/AI/TUI/cli/chatTuiPoc');
        await runChatTuiPoc();

        return;
    }

    // Stage 5: blessed TUI chat. Spawned by `converse()` via tmux.
    if (initialCommandType === '--tui-chat') {
        const { runChatTui } = await import('@/AI/TUI/cli/chatTui');
        await runChatTui(args.slice(1));

        return;
    }
    const hasValidCommandType = commandTypeOptions.some((option) => option.name === initialCommandType);

    if (isHelpFlag(initialCommandType)) {
        console.log(getAsciiHelp());

        return;
    }

    if (hasValidCommandType && isHelpFlag(args[1])) {
        console.log(getAsciiHelp(initialCommandType as CommandType));

        return;
    }

    if (!isInstalled()) {
        runInstall();
    }

    const commandType = hasValidCommandType
        ? initialCommandType as CommandType
        : await pickMenuOption({
            title: 'Pick a command group',
            header: workflowAscii,
            invalidValue: initialCommandType,
            invalidLabel: 'command group',
            usagePrefix: 'kra',
            options: commandTypeOptions,
        });

    const commandName = hasValidCommandType ? args[1] : undefined;

    if (commandType === 'settings') {
        const { handleChangeSettings } = await import('@/manageSettings');
        await handleChangeSettings();

        return;
    }

    if (commandType === 'memory') {
        const { memoryDashboard } = await import('@/AI');
        await memoryDashboard();

        return;
    }

    if (commandType === 'notes') {
        // Notes is dispatched directly so bare `kra notes` and `kra notes <name>`
        // both work without going through the command-selection menu.
        const { notesCommands } = await import('@/commandsMaps/notesCommands');
        const sub = args[1];
        const rest = args.slice(2);
        if (sub === 'new') {
            await notesCommands.new.run(rest);
        } else if (sub === 'pick') {
            await notesCommands.pick.run(rest);
        } else if (sub === 'journal') {
            await notesCommands.journal.run(rest);
        } else {
            await notesCommands.open.run(sub ? [sub, ...rest] : []);
        }

        return;
    }

    const command = await (async (): Promise<Command> => {
        switch (commandType) {
            case 'sys': {
                const { systemCommands } = await import('@/commandsMaps/systemCommands');

                return (await resolveCommandSelection({
                    title: 'kra sys',
                    header: `${sysAscii}\n\nPick a system command.`,
                    ...(commandName ? { invalidValue: commandName } : {}),
                    invalidLabel: 'system command',
                    commands: systemCommands,
                })).run;
            }
            case 'tmux': {
                const { tmuxCommands } = await import('@/commandsMaps/tmuxCommands');

                return (await resolveCommandSelection({
                    title: 'kra tmux',
                    header: `${tmuxAscii}\n\nPick a tmux command.`,
                    ...(commandName ? { invalidValue: commandName } : {}),
                    invalidLabel: 'tmux command',
                    commands: tmuxCommands,
                })).run;
            }
            case 'git': {
                const { gitCommands } = await import('@/commandsMaps/gitCommands');

                return (await resolveCommandSelection({
                    title: 'kra git',
                    header: `${gitAscii}\n\nPick a git command.`,
                    ...(commandName ? { invalidValue: commandName } : {}),
                    invalidLabel: 'git command',
                    commands: gitCommands,
                })).run;
            }
            case 'ai': {
                const { aiCommands } = await import('@/commandsMaps/aiCommands');

                return (await resolveCommandSelection({
                    title: 'kra ai',
                    header: `${aiAscii}\n\nPick an AI command.`,
                    ...(commandName ? { invalidValue: commandName } : {}),
                    invalidLabel: 'AI command',
                    commands: aiCommands,
                })).run;
            }
        }
    })();

    await command(args.slice(2));
};

main().catch((err) => {
    if (err instanceof UserCancelled) {
        process.exit(0);
    }
    console.error(err);
    process.exit(1);
});
