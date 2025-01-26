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
exports.LoadSessions = void 0;
const bash = __importStar(require("../helpers/bashHelper"));
const generalUI = __importStar(require("../UI/generalUI"));
const fs = __importStar(require("fs/promises"));
const nvim = __importStar(require("../helpers/neovimHelper"));
const BaseSession_1 = require("./BaseSession");
const SaveSessions_1 = require("../Sessions/SaveSessions");
class LoadSessions extends BaseSession_1.BaseSessions {
    constructor() {
        super();
        this.saveSessionsObject = new SaveSessions_1.Save();
        this.savedSessions = {};
        this.saveFileToLoadName = '';
    }
    getSessionsFromSaved() {
        return __awaiter(this, void 0, void 0, function* () {
            const itemsArray = yield this.getSavedSessionsNames();
            const fileName = yield generalUI.searchSelectAndReturnFromArray({
                itemsArray,
                prompt: "Select a session to load from the list:",
            });
            if (!fileName) {
                return;
            }
            const filePath = `${this.sessionsFilePath}/${fileName}`;
            const latestSessions = yield fs.readFile(filePath);
            this.saveFileToLoadName = fileName;
            this.savedSessions = JSON.parse(latestSessions.toString());
        });
    }
    printSavedSessions() {
        for (const sess in this.savedSessions) {
            const currentSession = this.savedSessions[sess];
            let panesCount = 0;
            let path = '';
            for (const window of currentSession.windows) {
                path = path || window.currentPath;
                panesCount += window.panes.length;
            }
            console.table({
                Name: sess,
                Path: path,
                Widnows: currentSession.windows.length,
                Panes: panesCount,
            });
        }
    }
    loadLatestSession() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                yield this.getSessionsFromSaved();
                if (!this.savedSessions || Object.keys(this.savedSessions).length === 0) {
                    console.error('No saved sessions found.');
                    return;
                }
                for (const sess of Object.keys(this.savedSessions)) {
                    yield this.createTmuxSession(sess);
                }
                yield this.sourceTmuxConfig();
                const firstSession = Object.keys(this.savedSessions)[0];
                yield this.attachToSession(firstSession);
            }
            catch (error) {
                console.error('Error in loadLatestSession:', error);
            }
        });
    }
    handleSessionsIfServerIsRunning() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.setCurrentSessions();
            let shouldSaveCurrentSessions = false;
            let serverIsRunning = false;
            if (JSON.stringify(this.currentSessions) !== '{}') {
                this.printSessions();
                serverIsRunning = true;
                shouldSaveCurrentSessions = yield generalUI.promptUserYesOrNo('Would you like to save currently running sessions?');
            }
            if (serverIsRunning && shouldSaveCurrentSessions) {
                yield this.saveSessionsObject.saveSessionsToFile();
                yield this.killTmuxServer();
                yield this.setTimeout(200);
            }
            if (serverIsRunning && !shouldSaveCurrentSessions) {
                yield this.killTmuxServer();
                yield this.setTimeout(200);
            }
        });
    }
    getSavedSessionsNames() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const files = yield fs.readdir(this.sessionsFilePath);
                return files.filter((file) => file !== '.gitkeep');
            }
            catch (error) {
                console.error('Error reading directory:', error);
                return [];
            }
        });
    }
    createTmuxSession(sessionName) {
        return __awaiter(this, void 0, void 0, function* () {
            const createSession = `tmux new-session -d -s ${sessionName}`;
            yield bash.execCommand(createSession);
            for (const [windowIndex, window] of this.savedSessions[sessionName].windows.entries()) {
                if (windowIndex > 0) {
                    const createWindow = `tmux new-window -n ${window.windowName} -c ~/`;
                    yield bash.execCommand(createWindow);
                }
                // Pane creation and commands
                for (const [paneIndex, pane] of window.panes.entries()) {
                    if (paneIndex > 0) {
                        const createPane = `tmux split-window -t ${sessionName}:${windowIndex} -c ~/`;
                        yield bash.execCommand(createPane);
                    }
                    yield this.navigateToFolder(pane, paneIndex);
                    if (pane.currentCommand === "nvim") {
                        yield nvim.loadNvimSession(this.saveFileToLoadName, sessionName, windowIndex, paneIndex);
                    }
                }
                const applyLayout = `tmux select-layout -t ${sessionName}:${windowIndex} "${window.layout}"`;
                yield bash.execCommand(applyLayout);
                yield bash.execCommand(`tmux select-pane -t ${sessionName}:${windowIndex}.0`);
                const settings = yield this.getSettings();
                if (settings.work && window.windowName === settings.workWindowNameForWatch) {
                    yield bash.sendKeysToTmuxTargetSession({
                        sessionName,
                        windowIndex,
                        paneIndex: 0,
                        command: settings.workCommandForWatch,
                    });
                }
                else if (!settings.work && window.windowName === settings.personalWindowNameForWatch) {
                    yield bash.sendKeysToTmuxTargetSession({
                        sessionName,
                        windowIndex,
                        paneIndex: 0,
                        command: settings.personalCommandForWatch,
                    });
                }
            }
            bash.execCommand('tmux select-window -t 0');
            const firstWindowName = this.savedSessions[sessionName].windows[0].windowName;
            const renameFirstWindow = `tmux rename-window -t ${sessionName}:0 ${firstWindowName}`;
            yield bash.execCommand(renameFirstWindow);
        });
    }
    navigateToFolder(pane, paneIndex) {
        return __awaiter(this, void 0, void 0, function* () {
            const pathArray = pane.currentPath.split('/');
            yield bash.sendKeysToTmuxTargetSession({
                paneIndex: paneIndex,
                command: 'cd'
            });
            for (let i = 3; i < pathArray.length; i++) {
                const folderPath = pathArray[i];
                console.log(`Checking existence of directory: ${folderPath}`);
                try {
                    yield bash.sendKeysToTmuxTargetSession({
                        paneIndex,
                        command: `[ -d '${folderPath}' ] && echo 'Directory exists' || (git clone ${pane.gitRepoLink} ${folderPath})`,
                    });
                    yield bash.sendKeysToTmuxTargetSession({
                        paneIndex,
                        command: `cd ${folderPath} && echo 'Navigated to ${folderPath}'`,
                    });
                    console.log(`Directory ${folderPath} exists`);
                }
                catch (error) {
                    console.error(`Error while checking or navigating: ${error}`);
                }
            }
        });
    }
}
exports.LoadSessions = LoadSessions;
