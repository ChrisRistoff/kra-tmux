#!/usr/bin/env node

import { LoadSessions } from "./Sessions/LoadSessions";
import { ManageSavedSessions } from "./Sessions/ManageSavedSessions";
import { Save } from "./Sessions/SaveSessions";
import * as nvim from './helpers/neovimHelper'

const saveSession = new Save();
const loadSessions = new LoadSessions();
const manageSessions = new ManageSavedSessions();

const main = async () => {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.log("No arguments provided. Please provide an argument.");
        process.exit(1);
    }

    switch (args[0]) {
        case 'settings':
            await nvim.openVim(`~/programming/kra-tmux/tmux-files/tmux-settings.txt`)
            break;
        case 'save':
            await mainSaveSessions();
            break;
        case 'load':
            await mainLoadSessions(args);
            break;
        case 'ls':
            await manageSessions.setCurrentSessions();
            manageSessions.printSessions();
            break;
        case 'delete':
            await manageSessions.deleteSession();
            break;
        case 'kill':
            await manageSessions.killTmuxServer();
            break;
        default:
            console.log(`Unknown command: ${args[0]}`);
            break;
    }
}

async function mainSaveSessions(): Promise<void> {
    await saveSession.saveSessionsToFile();
}

async function mainLoadSessions(args: string[]): Promise<void> {
    if (!args[1] || args[1] === '-l') {
        await loadSessions.handleSessionIfAlreadyRunning();
        console.log('session handled')
        await loadSessions.loadLatestSession();
    } else {
        console.log(`Invalid argument "${args[0]}"`);
    }
}

main();
