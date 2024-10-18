import { BaseGit } from "./BaseGit";
import fs from 'fs';
import * as bash from '../helpers/bashHelper';
import * as generalUI from "../UI/generalUI";

type PathInfoObject = {
    [key: string]: string,
}

export class GitUntracked extends BaseGit {
    private pathInfoFileName: string;
    private untrackedFilesFolderName: string;
    constructor() {
        super();

        this.pathInfoFileName = 'pathInfo';
        this.untrackedFilesFolderName = 'untracked';
    }

    // NOTE: CLEAN UP
    public async loadUntrackedFile(): Promise<void> {
        const gitBranchName = await this.getCurrentBranch();

        const savedUntrackedFiles = fs.readdirSync(`${this.gitFilesFolderPath}/${this.untrackedFilesFolderName}/${gitBranchName}`);

        const options: generalUI.SearchOptions = {
            prompt: "Pick a file to retrieve from stored untracked files: ",
            itemsArray: savedUntrackedFiles.filter(file => file !== this.pathInfoFileName),
        }

        let fileToLoadName = await generalUI.searchSelectAndReturnFromArray(options);

        const pathInfoObject: PathInfoObject = JSON.parse(fs.readFileSync(`${this.gitFilesFolderPath}/${this.untrackedFilesFolderName}/${gitBranchName}/${this.pathInfoFileName}`).toString())

        const fileToRetrievePathArray = pathInfoObject[fileToLoadName].split('/');
        fileToRetrievePathArray.pop()

        const fileToRetrievePath = fileToRetrievePathArray.join('/');

        await bash.execCommand(`mv ${this.gitFilesFolderPath}/${this.untrackedFilesFolderName}/${gitBranchName}/${fileToLoadName} ${fileToRetrievePath}`);
        console.log(`File ${fileToLoadName} moved back to ${fileToRetrievePath}`);
    }

    // NOTE: CLEAN UP
    public async saveUntrackedFile(): Promise<void> {
        const fileToSavePath: string | string[] = await this.getFileToMoveFromUser();

        if (Array.isArray(fileToSavePath)) {
            console.log("Can't do all right now.");
            return;
        }

        const gitBranchName: string = await this.getCurrentBranch();

        const branchFolderToSaveFileIn = `${this.gitFilesFolderPath}/${this.untrackedFilesFolderName}/${gitBranchName}`;

        const branchFolderAlreadyExists = fs.existsSync(branchFolderToSaveFileIn);
        if (!branchFolderAlreadyExists) {
            fs.mkdirSync(branchFolderToSaveFileIn);
        }

        const pathInProjectToUntrackedFile = `${await this.getTopLevelPath()}/${fileToSavePath}`;
        // move untracked file to git-files/<branch-name>
        await bash.execCommand(`mv ${pathInProjectToUntrackedFile} ${this.gitFilesFolderPath}/${this.untrackedFilesFolderName}/${gitBranchName}`);

        const infoFilePath = `${this.gitFilesFolderPath}/${this.untrackedFilesFolderName}/${gitBranchName}/${this.pathInfoFileName}`;

        const branchFileExists = fs.existsSync(infoFilePath);
        let pathInfoObject: PathInfoObject = {};

        if (branchFileExists) {
            pathInfoObject = JSON.parse(fs.readFileSync(infoFilePath).toString());
        }

        const fileName = this.getFileNameFromFilePath(fileToSavePath);

        pathInfoObject[fileName] = pathInProjectToUntrackedFile;

        const pathInfoObjectString = JSON.stringify(pathInfoObject, null, 2);

        fs.writeFileSync(infoFilePath, pathInfoObjectString, 'utf-8');

        console.log(`File ${fileName} has been saved under branch name "${gitBranchName}"`);
    }

    public async getFileToMoveFromUser(): Promise<string | string[]> {
        const itemsArray = await this.getUntrackedFilesNamesArray();

        itemsArray.unshift('All');

        const options: generalUI.SearchOptions = {
            prompt: "Pick a file to save and remove from project: ",
            itemsArray,
        }

        const fileToSave = await generalUI.searchSelectAndReturnFromArray(options);

        return fileToSave;
    }

    public async getUntrackedFilesNamesArray(): Promise<string[]> {
        const files = await bash.execCommand("git ls-files --others --exclude-standard").then(std => std.stdout.split('\n'));

        if (files[files.length - 1] === '') {
            files.pop();
        }

        return files;
    }
}
