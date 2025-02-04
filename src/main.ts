#!/usr/bin/env node

import 'module-alias/register';
import { aiCommands } from './commandsMaps/aiCommands';
import { gitCommands } from './commandsMaps/gitCommands';
import { tmuxCommands } from './commandsMaps/tmuxCommands';
import { systemCommands } from './commandsMaps/systemCommands';
import { handleChangeSettings } from './manageSettings';

const main = async (): Promise<void> => {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.log('No argument.');
        process.exit(1);
    }

    if (args[0] === 'sys' && systemCommands[args[1]]) {
        await systemCommands[args[1]]();
        return;
    }

    if (args[0] === 'tmux' && tmuxCommands[args[1]]) {
        await tmuxCommands[args[1]]();
        return;
    }

    if (args[0] === 'git' && gitCommands[args[1]]) {
        await gitCommands[args[1]]();
        return;
    }

    if (args[0] === 'ai' && aiCommands[args[1]]) {
        await aiCommands[args[1]]();
        return;
    }

    if (args[0] === 'settings') {
        await handleChangeSettings();
    }

    console.log('Command not a command.');
};

main();
