import { LoadSessions } from "../Sessions/LoadSessions";
import { ManageSavedSessions } from "../Sessions/ManageSavedSessions";
import { Save } from "../Sessions/SaveSessions";
import * as nvim from '../helpers/neovimHelper'
import * as toml from 'toml'
import * as fs from 'fs/promises'

const saveSession = new Save();
const loadSessions = new LoadSessions();
const manageSessions = new ManageSavedSessions();

type TmuxCommands = {
    [key: string]: () => Promise<void>,
}

export const tmuxCommands: TmuxCommands = {
    'set': handleChangeSettings,
    'save': handleSaveSessions,
    'load': handleLoadSession,
    'ls': handlePrintSessions,
    'del': handleDeleteSession,
    'kill': handleKillTmuxServer,
}

async function handleChangeSettings(): Promise<void> {
    const settingsFilePath = `~/programming/settings.toml`
    let settingsFileString = await fs.readFile(`${__dirname}/../../settings.toml`, 'utf8')
    const oldSettings = await toml.parse(settingsFileString)
    await nvim.openVim(settingsFilePath)
    settingsFileString = await fs.readFile(`${__dirname}/../../settings.toml`, 'utf8')
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

async function handleSaveSessions(): Promise<void> {
    await saveSession.saveSessionsToFile();
}

async function handleLoadSession(): Promise<void> {
    await loadSessions.handleSessionsIfServerIsRunning();
    await loadSessions.loadLatestSession();
}

async function handlePrintSessions(): Promise<void> {
    await manageSessions.setCurrentSessions();
    manageSessions.printSessions();
}
async function handleDeleteSession(): Promise<void>  {
    await manageSessions.deleteSession();
}

async function handleKillTmuxServer(): Promise<void> {
    await manageSessions.killTmuxServer();
}
