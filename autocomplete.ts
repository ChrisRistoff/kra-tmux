import fs from 'fs';
import * as bash from './src/helpers/bashHelper';
import { homedir } from 'os';

const completionScript = `${__dirname}/../auto.sh`;
const bashrc = `${homedir()}/.bashrc`;
const zshrc = `${homedir()}/.zshrc`;

function appendToShellRc(rcFile: string, line: string) {
    if (fs.existsSync(rcFile)) {
        const content = fs.readFileSync(rcFile, 'utf8');
        if (!content.includes(line)) {
            fs.appendFileSync(rcFile, `\n${line}\n`);
            console.log(`Added autocompletion to ${rcFile}`);
        }
    }
}

const sourceLine = `source ${completionScript}`;

appendToShellRc(bashrc, sourceLine);
appendToShellRc(zshrc, sourceLine);

const sourceScriptPath = `${__dirname}/../reload.sh`
fs.writeFileSync(sourceScriptPath, `#!/bin/bash\nsource ~/.bashrc\nsource ~/.zshrc\necho "Shell configuration reloaded."`, { mode: 0o755 });

const main = async () => {
    await bash.execCommand(`bash ${sourceScriptPath}`);
    fs.rmSync(sourceScriptPath);
    return 'Shell configuration reloaded.';
}

main().then(res => console.log(res));
