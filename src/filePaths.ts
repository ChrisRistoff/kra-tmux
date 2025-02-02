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
export const nvimTreeSwapFilePath = path.join(homeDir, '/.local/state/nvim/swap//%home%krasen%programming%kra-tmux%NvimTree_1.swp')
