#!/usr/bin/env node

import { gitCommands } from './CommandsMaps/gitCommands';
import { tmuxCommands } from './CommandsMaps/tmuxCommands';

const main = async (): Promise<void> => {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.log("No arguments provided. Please provide an argument.");
        process.exit(1);
    }

    if (tmuxCommands[args[0]]) {
        await tmuxCommands[args[0]]()
        return;
    }

    if (gitCommands[args[0]]) {
        await gitCommands[args[0]](args)
        return;
    }

    console.log('Command not a command')
}

main();
