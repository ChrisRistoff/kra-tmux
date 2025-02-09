import fs from 'fs/promises';

export async function makeExecutableIfNoPermissions(filePath: string): Promise<void> {
    try {
        const stats = await fs.stat(filePath);
        const currentPermissions = stats.mode;

        const hasExecutePermissions =
            (currentPermissions & fs.constants.S_IXUSR)
            || (currentPermissions & fs.constants.S_IXGRP)
            || (currentPermissions & fs.constants.S_IXOTH);

        if (!hasExecutePermissions) {
            const newPermissions = currentPermissions | fs.constants.S_IXUSR | fs.constants.S_IXGRP | fs.constants.S_IXOTH;

            await fs.chmod(filePath, newPermissions);
            console.log(`Added execute permissions to ${filePath}`);
        } else {
            console.log(`${filePath} already has execute permissions.`);
        }
    } catch (error) {
        console.error(`An error occurred: ${error}`);
    }
}
