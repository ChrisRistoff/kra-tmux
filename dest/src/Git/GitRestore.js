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
Object.defineProperty(exports, "__esModule", { value: true });
exports.GitRestore = void 0;
const BaseGit_1 = require("./BaseGit");
const bash = __importStar(require("../helpers/bashHelper"));
const generalUI = __importStar(require("../UI/generalUI"));
class GitRestore extends BaseGit_1.BaseGit {
    constructor() {
        super();
    }
    restoreFile() {
        return __awaiter(this, void 0, void 0, function* () {
            const fileToRestore = yield this.getFileToRestoreFromUser();
            if (!fileToRestore) {
                return;
            }
            if (fileToRestore === "All") {
                yield bash.execCommand('git restore ./');
                return;
            }
            yield bash.execCommand(`git restore ${fileToRestore}`);
        });
    }
    getFileToRestoreFromUser() {
        return __awaiter(this, void 0, void 0, function* () {
            const itemsArray = yield this.getModifiedFilesNamesArray();
            itemsArray.unshift('All');
            const options = {
                prompt: "Pick a file to restore: ",
                itemsArray,
            };
            const fileToRestore = yield generalUI.searchSelectAndReturnFromArray(options);
            return fileToRestore;
        });
    }
    getModifiedFilesNamesArray() {
        return __awaiter(this, void 0, void 0, function* () {
            const files = yield bash.execCommand("git status --porcelain | awk '/^[ MARC]/{print $2}'").then(std => std.stdout.split('\n'));
            if (files[files.length - 1] === '') {
                files.pop();
            }
            return files;
        });
    }
}
exports.GitRestore = GitRestore;
