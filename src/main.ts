#!/usr/bin/env node

import { LoadSessions } from "./Sessions/LoadSessions";
import { ManageSavedSessions } from "./Sessions/ManageSavedSessions";
import { Save } from "./Sessions/SaveSessions";
import * as nvim from './helpers/neovimHelper'
import * as toml from 'toml'
import * as fs from 'fs/promises'

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
            await handleChangeSettings();
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
        await loadSessions.handleSessionsIfServerIsRunning();
        console.log('session handled')
        await loadSessions.loadLatestSession();
    } else {
        console.log(`Invalid argument "${args[0]}"`);
    }
}

async function handleChangeSettings(): Promise<void> {
    const settingsFilePath = `~/programming/kra-tmux/tmux-files/settings.toml`
    let settingsFileString = await fs.readFile(`${__dirname}/../../tmux-files/settings.toml`, 'utf8')
    const oldSettings = await toml.parse(settingsFileString)
    await nvim.openVim(settingsFilePath)
    settingsFileString = await fs.readFile(`${__dirname}/../../tmux-files/settings.toml`, 'utf8')
    const newSettings = await toml.parse(settingsFileString)

    console.log('Changed settings below:')

    for (const setting of Object.keys(oldSettings)) {
        if (oldSettings[setting] !== newSettings[setting]) {
            console.table({
                'Setting': setting
            })
            console.table({
                'Old value': `${oldSettings[setting]}`,
                'New setting': `${newSettings[setting]}`
            })
        }
    }
}

main();
