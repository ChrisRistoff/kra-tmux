import { BaseGit } from "./BaseGit";
import fs from 'fs';
import * as bash from '../helpers/bashHelper';
import * as generalUI from "../UI/generalUI";

type PathInfoObject = {
    [key: string]: string,
}

export class GitUntracked extends BaseGit {
    private pathInfoFileName: string;
    private filesFolderName: string;
    constructor() {
        super();

        this.pathInfoFileName = 'pathInfo';
        this.filesFolderName = 'untracked';
    }

    // NOTE: CLEAN UP
    public async loadUntrackedFile(): Promise<void> {
        const gitBranchName = await this.getCurrentBranch();

        const storedUntrackedFiles = fs.readdirSync(`${this.gitFilesFolderPath}/${this.filesFolderName}/${gitBranchName}`);

        const options: generalUI.SearchOptions = {
            prompt: "Pick a file to retrieve from stored untracked files: ",
            itemsArray: storedUntrackedFiles.filter(file => file !== this.pathInfoFileName),
        }

        let fileToRetrieve = await generalUI.searchSelectAndReturnFromArray(options);

        const pathInfoObject: PathInfoObject = JSON.parse(fs.readFileSync(`${this.gitFilesFolderPath}/${this.filesFolderName}/${gitBranchName}/${this.pathInfoFileName}`).toString())

        const fileToRetrievePathArray = pathInfoObject[fileToRetrieve].split('/');
        fileToRetrievePathArray.pop()

        const fileToRetrievePath = fileToRetrievePathArray.join('/');

        await bash.execCommand(`mv ${this.gitFilesFolderPath}/${this.filesFolderName}/${gitBranchName}/${fileToRetrieve} ${fileToRetrievePath}`);
        console.log(`File ${fileToRetrieve} moved back to ${fileToRetrievePath}`);
    }

    // NOTE: CLEAN UP
    public async saveUntrackedFile(): Promise<void> {
        const fileToMove = await this.getFileToMoveFromUser();

        if (Array.isArray(fileToMove)) {
            console.log("Can't do all right now.");
            return;
        }

        const gitBranchName = await this.getCurrentBranch();

        const fileToMoveFilePath = `${await this.getTopLevelPath()}/${fileToMove}`;

        const gitBranchFolderPath = `${this.gitFilesFolderPath}/${this.filesFolderName}/${gitBranchName}`;
        const branchFolderAlreadyExists = fs.existsSync(gitBranchFolderPath);

        if (!branchFolderAlreadyExists) {
            fs.mkdirSync(gitBranchFolderPath);
        }

        await bash.execCommand(`mv ${fileToMoveFilePath} ${this.gitFilesFolderPath}/${this.filesFolderName}/${gitBranchName}`);

        const fileToMoveArray = fileToMove.split('/');
        const fileName = fileToMoveArray[fileToMoveArray.length - 1];

        const infoFilePath = `${this.gitFilesFolderPath}/${this.filesFolderName}/${gitBranchName}/${this.pathInfoFileName}`;

        const branchFileExists = fs.existsSync(infoFilePath);
        let pathInfoObject: PathInfoObject = {};

        if (branchFileExists) {
            pathInfoObject = JSON.parse(fs.readFileSync(infoFilePath).toString());
        }

        pathInfoObject[fileName] = fileToMoveFilePath;

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
