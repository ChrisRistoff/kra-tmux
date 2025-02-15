#!/usr/bin/env node

import 'module-alias/register';
import { aiCommands } from './commandsMaps/aiCommands';
import { gitCommands } from './commandsMaps/gitCommands';
import { tmuxCommands } from './commandsMaps/tmuxCommands';
import { systemCommands } from './commandsMaps/systemCommands';
import { handleChangeSettings } from './manageSettings';
import { SystemCommands, TmuxCommands, GitCommands, AiCommands, Command } from './commandsMaps/types/commandTypes';

const main = async (): Promise<void> => {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.log('No argument.');
        process.exit(1);
    }

    const commandType = args[0];
    const commandName = args[1];

    if (!commandType || !commandName) {
        console.log('Command not found.');
        process.exit(1);
    }

    let command: Command;

    switch (commandType) {
        case 'sys':
            command = systemCommands[commandName as keyof SystemCommands];
            break;
        case 'tmux':
            command = tmuxCommands[commandName as keyof TmuxCommands];
            break;
        case 'git':
            command = gitCommands[commandName as keyof GitCommands];
            break;
        case 'ai':
            command = aiCommands[commandName as keyof AiCommands];
            break;
        case 'settings':
            await handleChangeSettings();
            return;
        default:
            console.log('Invalid command type.');
            process.exit(1);
    }

    try {
        await command();
    } catch (error) {
        throw new Error('Command not found');
    }

    console.log("Done")
}

main().then((_res) => console.log('Done.')).catch((err) => console.log(err));
