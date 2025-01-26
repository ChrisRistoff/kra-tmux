"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GitUntracked = void 0;
const BaseGit_1 = require("./BaseGit");
const fs_1 = __importDefault(require("fs"));
const bash = __importStar(require("../helpers/bashHelper"));
const generalUI = __importStar(require("../UI/generalUI"));
class GitUntracked extends BaseGit_1.BaseGit {
    constructor() {
        super();
        this.pathInfoFileName = 'pathInfo';
        this.untrackedFilesFolderName = 'untracked';
    }
    loadUntracked() {
        return __awaiter(this, void 0, void 0, function* () {
            const gitBranchName = yield this.getCurrentBranch();
            const savedUntrackedFiles = fs_1.default.readdirSync(`${this.gitFilesFolderPath}/${this.untrackedFilesFolderName}/${gitBranchName}`).filter(file => file !== this.pathInfoFileName);
            savedUntrackedFiles.unshift('all');
            const options = {
                prompt: "Pick a file to retrieve from stored untracked files: ",
                itemsArray: savedUntrackedFiles,
            };
            let fileToLoadName = yield generalUI.searchSelectAndReturnFromArray(options);
            if (fileToLoadName === 'all') {
                savedUntrackedFiles.shift();
                return yield this.loadMultipleUntrackedFiles(savedUntrackedFiles, gitBranchName);
            }
            yield this.loadUntrackedFile(fileToLoadName, gitBranchName);
        });
    }
    loadMultipleUntrackedFiles(filesToLoadArray, gitBranchName) {
        return __awaiter(this, void 0, void 0, function* () {
            filesToLoadArray.forEach((file) => __awaiter(this, void 0, void 0, function* () {
                yield this.loadUntrackedFile(file, gitBranchName);
            }));
        });
    }
    loadUntrackedFile(fileToLoadName, gitBranchName) {
        return __awaiter(this, void 0, void 0, function* () {
            const pathInfoObject = JSON.parse(fs_1.default.readFileSync(`${this.gitFilesFolderPath}/${this.untrackedFilesFolderName}/${gitBranchName}/${this.pathInfoFileName}`).toString());
            const fileToRetrievePathArray = pathInfoObject[fileToLoadName].split('/');
            fileToRetrievePathArray.pop();
            const fileToRetrievePath = fileToRetrievePathArray.join('/');
            yield bash.execCommand(`mv ${this.gitFilesFolderPath}/${this.untrackedFilesFolderName}/${gitBranchName}/${fileToLoadName} ${fileToRetrievePath}`);
            console.log(`File ${fileToLoadName} moved back to ${fileToRetrievePath}`);
        });
    }
    saveUntracked() {
        return __awaiter(this, void 0, void 0, function* () {
            const fileToSavePath = yield this.getFileToMoveFromUser();
            const gitBranchName = yield this.getCurrentBranch();
            if (Array.isArray(fileToSavePath)) {
                return yield this.saveMultipleUntrackedFiles(fileToSavePath, gitBranchName);
            }
            return yield this.saveUntrackedFile(fileToSavePath, gitBranchName);
        });
    }
    saveMultipleUntrackedFiles(filesToSaveArray, gitBranchName) {
        return __awaiter(this, void 0, void 0, function* () {
            filesToSaveArray.forEach((file) => __awaiter(this, void 0, void 0, function* () {
                yield this.saveUntrackedFile(file, gitBranchName);
            }));
        });
    }
    saveUntrackedFile(fileToSavePath, gitBranchName) {
        return __awaiter(this, void 0, void 0, function* () {
            const branchFolderToSaveFileIn = `${this.gitFilesFolderPath}/${this.untrackedFilesFolderName}/${gitBranchName}`;
            const branchFolderAlreadyExists = fs_1.default.existsSync(branchFolderToSaveFileIn);
            if (!branchFolderAlreadyExists) {
                fs_1.default.mkdirSync(branchFolderToSaveFileIn);
            }
            const pathInProjectToUntrackedFile = `${yield this.getTopLevelPath()}/${fileToSavePath}`;
            // move untracked file to git-files/<branch-name>
            yield bash.execCommand(`mv ${pathInProjectToUntrackedFile} ${this.gitFilesFolderPath}/${this.untrackedFilesFolderName}/${gitBranchName}`);
            const infoFilePath = `${this.gitFilesFolderPath}/${this.untrackedFilesFolderName}/${gitBranchName}/${this.pathInfoFileName}`;
            const branchFileExists = fs_1.default.existsSync(infoFilePath);
            let pathInfoObject = {};
            if (branchFileExists) {
                pathInfoObject = JSON.parse(fs_1.default.readFileSync(infoFilePath).toString());
            }
            const fileName = this.getFileNameFromFilePath(fileToSavePath);
            pathInfoObject[fileName] = pathInProjectToUntrackedFile;
            const pathInfoObjectString = JSON.stringify(pathInfoObject, null, 2);
            fs_1.default.writeFileSync(infoFilePath, pathInfoObjectString, 'utf-8');
            console.log(`File ${fileName} has been saved under branch name "${gitBranchName}"`);
        });
    }
    // NOTE: Remove this
    getFileToMoveFromUser() {
        return __awaiter(this, void 0, void 0, function* () {
            const itemsArray = yield this.getUntrackedFilesNamesArray();
            itemsArray.unshift('all');
            const options = {
                prompt: "Pick a file to save and remove from project: ",
                itemsArray,
            };
            const fileToSave = yield generalUI.searchSelectAndReturnFromArray(options);
            if (fileToSave === 'all') {
                itemsArray.shift();
                return itemsArray;
            }
            return fileToSave;
        });
    }
    getUntrackedFilesNamesArray() {
        return __awaiter(this, void 0, void 0, function* () {
            const files = yield bash.execCommand("git ls-files --others --exclude-standard").then(std => std.stdout.split('\n'));
            if (files[files.length - 1] === '') {
                files.pop();
            }
            return files;
        });
    }
}
exports.GitUntracked = GitUntracked;
