import fs from 'fs';
import path from "path";
import * as bash from '../../utils/bashHelper';
import * as ui from "../../UI/generalUI";
import { gitFilesFolder } from "../../filePaths";
import { getCurrentBranch, getTopLevelPath } from "../core/gitBranch";
import { getUntrackedFiles } from "../utils/gitFileUtils";
import { UNTRACKED_CONFIG } from "../config/gitConstants";
import { PathInfoObject } from '../types/gitTypes';

async function getFileToMoveFromUser(): Promise<string | string[]> {
    const itemsArray = await getUntrackedFiles();
    itemsArray.unshift('all');

    const fileToSave = await ui.searchSelectAndReturnFromArray({
        prompt: "Pick a file to save and remove from project: ",
        itemsArray,
    });

    if (fileToSave === 'all') {
        itemsArray.shift();
        return itemsArray;
    }

    return fileToSave;
}

async function saveUntrackedFile(fileToSavePath: string, gitBranchName: string): Promise<void> {
    const branchFolderToSaveFileIn = path.join(
        gitFilesFolder,
        UNTRACKED_CONFIG.untrackedFilesFolderName,
        gitBranchName
    );

    if (!fs.existsSync(branchFolderToSaveFileIn)) {
        fs.mkdirSync(branchFolderToSaveFileIn, { recursive: true });
    }

    const topLevelPath = await getTopLevelPath();
    const pathInProjectToUntrackedFile = path.join(topLevelPath, fileToSavePath);

    await bash.execCommand(
        `mv ${pathInProjectToUntrackedFile} ${branchFolderToSaveFileIn}`
    );

    const infoFilePath = path.join(branchFolderToSaveFileIn, UNTRACKED_CONFIG.pathInfoFileName);
    let pathInfoObject: PathInfoObject = {};

    if (fs.existsSync(infoFilePath)) {
        pathInfoObject = JSON.parse(fs.readFileSync(infoFilePath).toString());
    }

    const fileName = path.basename(fileToSavePath);
    pathInfoObject[fileName] = pathInProjectToUntrackedFile;

    fs.writeFileSync(
        infoFilePath,
        JSON.stringify(pathInfoObject, null, 2),
        'utf-8'
    );

    console.log(`File ${fileName} has been saved under branch name "${gitBranchName}"`);
}

async function loadUntrackedFile(fileToLoadName: string, gitBranchName: string): Promise<void> {
    const pathInfoObject: PathInfoObject = JSON.parse(
        fs.readFileSync(
            path.join(
                gitFilesFolder,
                UNTRACKED_CONFIG.untrackedFilesFolderName,
                gitBranchName,
                UNTRACKED_CONFIG.pathInfoFileName
            )
        ).toString()
    );

    const fileToRetrievePathArray = pathInfoObject[fileToLoadName].split('/');
    fileToRetrievePathArray.pop();
    const fileToRetrievePath = fileToRetrievePathArray.join('/');

    const untrackedFolder = path.join(
        gitFilesFolder,
        UNTRACKED_CONFIG.untrackedFilesFolderName,
        gitBranchName,
        fileToLoadName
    );

    await bash.execCommand(`mv ${untrackedFolder} ${fileToRetrievePath}`);
    console.log(`File ${fileToLoadName} moved back to ${fileToRetrievePath}`);
}

export async function saveUntracked(): Promise<void> {
    const fileToSavePath = await getFileToMoveFromUser();
    const gitBranchName = await getCurrentBranch();

    if (Array.isArray(fileToSavePath)) {
        await Promise.all(fileToSavePath.map(file => saveUntrackedFile(file, gitBranchName)));
    } else {
        await saveUntrackedFile(fileToSavePath, gitBranchName);
    }
}

export async function loadUntracked(): Promise<void> {
    const gitBranchName = await getCurrentBranch();
    const branchPath = path.join(
        gitFilesFolder,
        UNTRACKED_CONFIG.untrackedFilesFolderName,
        gitBranchName
    );

    const savedUntrackedFiles = fs.readdirSync(branchPath)
        .filter(file => file !== UNTRACKED_CONFIG.pathInfoFileName);

    savedUntrackedFiles.unshift('all');

    const fileToLoadName = await ui.searchSelectAndReturnFromArray({
        prompt: "Pick a file to retrieve from stored untracked files: ",
        itemsArray: savedUntrackedFiles,
    });

    if (fileToLoadName === 'all') {
        savedUntrackedFiles.shift();
        await Promise.all(savedUntrackedFiles.map(file => loadUntrackedFile(file, gitBranchName)));
        return;
    }

    await loadUntrackedFile(fileToLoadName, gitBranchName);
}
