#!/usr/bin/env node

import 'module-alias/register';
import { aiCommands, handleAiCommandNotExist } from '@/commandsMaps/aiCommands';
import { gitCommands, handleGitCommandNotExist } from '@/commandsMaps/gitCommands';
import { handleTmuxCommandNotExist , tmuxCommands } from '@/commandsMaps/tmuxCommands';
import { handleSysCommandNotExist, systemCommands } from '@/commandsMaps/systemCommands';
import { handleChangeSettings } from '@/manageSettings';
import { SystemCommands, TmuxCommands, GitCommands, AiCommands, Command } from '@/commandsMaps/types/commandTypes';
import { workflowAscii } from '@/data/workflow-ascii';
import { UserCancelled } from '@/UI/menuChain';

const main = async (): Promise<void> => {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.log(workflowAscii);
        process.exit(1);
    }

    const commandType = args[0];
    let commandName = args[1];

    let command: Command;

    switch (commandType) {
        case 'sys':
            handleSysCommandNotExist(commandName);
            command = systemCommands[commandName as keyof SystemCommands];
            break;
        case 'tmux':
            handleTmuxCommandNotExist(commandName);
            command = tmuxCommands[commandName as keyof TmuxCommands];
            break;
        case 'git':
            handleGitCommandNotExist(commandName);
            command = gitCommands[commandName as keyof GitCommands];
            break;
        case 'ai':
            handleAiCommandNotExist(commandName);
            command = aiCommands[commandName as keyof AiCommands];
            break;
        case 'settings':
            await handleChangeSettings();

            return;
        default:
            console.log(workflowAscii);
            console.table({[`${commandType}`]: 'Is not a valid command'});
            process.exit(1);
    }

    try {
        await command();
    } catch (error) {
        throw error;
    }
}

main().catch((err) => {
    if (err instanceof UserCancelled) {
        process.exit(0);
    }
    console.error(err);
    process.exit(1);
});
