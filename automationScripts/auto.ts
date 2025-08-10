import fs from 'fs';
import * as bash from '../src/utils/bashHelper';
import { homedir } from 'os';

const completionScript = `${__dirname}/../../automationScripts/source-all.sh`;
const bashrc = `${homedir()}/.bashrc`;
const zshrc = `${homedir()}/.zshrc`;

function appendToShellRc(rcFile: string, line: string): void {
    if (fs.existsSync(rcFile)) {
        const rcFileContent = fs.readFileSync(rcFile, 'utf8');

        if (!rcFileContent.includes(line)) {
            fs.appendFileSync(rcFile, `\n${line}\n`);
            console.log(`Added autocompletion to ${rcFile}`);
        }
    }
}

function setupNeovimConfig() {
    const nvimConfigDir = `${homedir()}/.config/nvim/lua`;
    const autosaveHookFile = `${nvimConfigDir}/neovimHooks.lua`;
    const nvimInitFile = `${homedir()}/.config/nvim/init.lua`;

    if (!fs.existsSync(nvimConfigDir)) {
        fs.mkdirSync(nvimConfigDir, { recursive: true });
    }

    fs.copyFileSync(`${__dirname}/../../automationScripts/neovimHooks.lua`, autosaveHookFile);

    const requireLine = 'require("neovimHooks")';

    if (fs.existsSync(nvimInitFile)) {
        const initContent = fs.readFileSync(nvimInitFile, 'utf8');

        if (!initContent.includes(requireLine)) {
            fs.appendFileSync(nvimInitFile, `\n${requireLine}\n`);
        }
    } else {
        fs.writeFileSync(nvimInitFile, requireLine);
    }
}


const sourceLine = `source ${completionScript}`;

appendToShellRc(bashrc, sourceLine);
appendToShellRc(zshrc, sourceLine);
setupNeovimConfig();

const sourceScriptPath = `${__dirname}/../reload.sh`;

fs.writeFileSync(sourceScriptPath, '#!/bin/bash\nsource ~/.bashrc\nsource ~/.zshrc\necho "Shell configuration reloaded."', { mode: 0o755 });

const main = async (): Promise<string> => {
    await bash.execCommand(`chmod +x ${sourceScriptPath}`)
    await bash.execCommand(`bash ${sourceScriptPath}`);
    fs.rmSync(sourceScriptPath);

    return 'Shell configuration reloaded.';
};

main().then(res => console.log(res)).catch((err) => console.log(err));
