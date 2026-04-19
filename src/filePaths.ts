import os from 'os';
import path from 'path';

const homeDir = os.homedir();
const projectRoot = path.join(homeDir, 'programming', 'kra-tmux');

//settings
export const settingsFilePath = path.join(projectRoot, 'settings.toml');

// git
export const gitFilesFolder = path.join(projectRoot, 'git-files');

// tmux
export const sessionFilesFolder = path.join(projectRoot, 'tmux-files/sessions');

// nvim
export const nvimSessionsPath = path.join(projectRoot, 'tmux-files/nvim-sessions');

// ai
export const aiHistoryPath = path.join(projectRoot, 'ai-files/chat-history');
export const neovimConfig = path.join(projectRoot, 'ai-files/init.lua');

// system
export const systemFilesPath = path.join(projectRoot, 'system-files');
export const systemScriptsPath = path.join(projectRoot, 'system-files', 'scripts');

// lock
export const lockFilesPath = path.join(projectRoot, 'lock-files');

// worker
export const loadSessionWorkerPath = path.join(projectRoot, 'src/tmux/workers/loadSessionWorker.js');
