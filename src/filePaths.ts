import os from 'os';
import path from 'path';

const homeDir = os.homedir();
const projectPath = 'programming/kra-tmux/'

//settings
export const settingsFilePath = path.join(homeDir, projectPath,'settings.toml');

// git
export const gitFilesFolder = path.join(homeDir, projectPath, 'git-files');

// tmux
export const sessionFilesFolder = path.join(homeDir, projectPath, 'tmux-files/sessions');

// nvim
export const nvimSessionsPath = path.join(homeDir, projectPath, 'tmux-files/nvim-sessions');

// ai
export const aiHistoryPath = path.join(homeDir, projectPath, 'ai-files/chat-history');

// system
export const systemFilesPath = path.join(homeDir, projectPath, 'system-files');
export const systemScriptsPath = path.join(homeDir, projectPath, 'system-files', 'scripts');
