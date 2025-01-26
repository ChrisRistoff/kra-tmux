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
exports.Save = void 0;
const bash = __importStar(require("../helpers/bashHelper"));
const nvim = __importStar(require("../helpers/neovimHelper"));
const fs = __importStar(require("fs/promises"));
const BaseSession_1 = require("./BaseSession");
const generalUI = __importStar(require("../UI/generalUI"));
class Save extends BaseSession_1.BaseSessions {
    constructor() {
        super();
    }
    saveSessionsToFile() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.setCurrentSessions();
            const sessionString = JSON.stringify(this.currentSessions, null, 2);
            if (sessionString === '{}') {
                console.log('No sessions found to save!');
                return;
            }
            const fileName = yield this.getFileNameFromUser();
            for (const session of Object.keys(this.currentSessions)) {
                const currentSession = this.currentSessions[session];
                for (let i = 0; i < currentSession.windows.length; i++) {
                    const windowIndex = i;
                    const currentWindow = currentSession.windows[i];
                    for (let i = 0; i < currentWindow.panes.length; i++) {
                        if (currentWindow.panes[i].currentCommand === 'nvim') {
                            yield nvim.saveNvimSession(fileName, session, windowIndex, i);
                        }
                    }
                }
            }
            const filePath = `${__dirname}/../../../tmux-files/sessions/${fileName}`;
            yield fs.writeFile(filePath, sessionString, 'utf-8');
            console.log('Save Successful!');
        });
    }
    getFileNameFromUser() {
        return __awaiter(this, void 0, void 0, function* () {
            let branchName;
            try {
                branchName = yield bash.execCommand('git rev-parse --abbrev-ref HEAD').then(res => res.stdout);
            }
            catch (error) {
                branchName = '';
            }
            if (!branchName) {
                return yield generalUI.askUserForInput('Please write a name for save: ');
            }
            branchName = branchName.split('\n')[0];
            const message = `Would you like to use ${branchName} as part of your name for your save?`;
            const shouldSaveBranchNameAsFileName = yield generalUI.promptUserYesOrNo(message);
            const itemsArray = yield fs.readdir(this.sessionsFilePath);
            const options = {
                prompt: 'Please write a name for save: ',
                itemsArray,
            };
            if (!shouldSaveBranchNameAsFileName) {
                const sessionName = yield generalUI.searchAndSelect(options);
                return sessionName;
            }
            console.log(`Please write a name for your save, it will look like this: ${branchName}-<your-input>`);
            const sessionName = yield generalUI.searchAndSelect(options);
            return `${branchName}-${sessionName}-${this.getDate()}`;
        });
    }
    getDate() {
        const dateArray = new Date().toString().split(' ');
        let timeArray = dateArray[4].split(':');
        timeArray.pop();
        const timeString = timeArray.join(':');
        const yearMonthDayTime = [dateArray[3], dateArray[1], dateArray[2], timeString];
        const fileName = yearMonthDayTime.join('-');
        return fileName;
    }
}
exports.Save = Save;
