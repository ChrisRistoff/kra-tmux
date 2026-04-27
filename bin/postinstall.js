#!/usr/bin/env node
'use strict';

// npm postinstall entrypoint. Mirrors bin/kra.js so module-alias can find @/*.
// Wrapped in try/catch so a setup failure NEVER breaks `npm install`.

const path = require('path');

try {
    const moduleAlias = require('module-alias');
    const pkgRoot = path.resolve(__dirname, '..');
    moduleAlias.addAliases({ '@': path.join(pkgRoot, 'dest', 'src') });

    // npm runs postinstall under the invoking user's HOME unless `sudo` was used.
    // When sudo'd globally, HOME is root's; redirect to the real user when possible
    // so we don't litter /root or /var/root with dotfiles.
    if (process.getuid && process.getuid() === 0 && process.env.SUDO_USER) {
        const { execSync } = require('child_process');
        try {
            const realHome = execSync(`/usr/bin/env getent passwd ${process.env.SUDO_USER} 2>/dev/null || dscl . -read /Users/${process.env.SUDO_USER} NFSHomeDirectory 2>/dev/null`).toString();
            const match = realHome.match(/(?:^[^:]+:[^:]*:[^:]*:[^:]*:[^:]*:)([^:\n]+)|NFSHomeDirectory:\s*(\S+)/);
            const home = match && (match[1] || match[2]);
            if (home) {
                process.env.HOME = home;
                console.log(`[kra-workflow] running setup as root; targeting HOME=${home} (SUDO_USER=${process.env.SUDO_USER})`);
            }
        } catch {
            // best-effort only
        }
    }

    const { runInstall } = require(path.join(pkgRoot, 'dest', 'src', 'setup', 'install.js'));
    runInstall();
} catch (err) {
    console.warn('[kra-workflow] postinstall setup skipped:', err && err.message ? err.message : err);
    console.warn('[kra-workflow] run any `kra` command to retry setup, or reinstall the package.');
}
