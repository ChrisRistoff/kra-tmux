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
exports.BaseSessions = void 0;
const bash = __importStar(require("../helpers/bashHelper"));
const Base_1 = require("../Base");
class BaseSessions extends Base_1.Base {
    constructor() {
        super();
        this.currentSessions = {};
        this.sessionsFilePath = `${__dirname}/../../../tmux-files/sessions`;
    }
    setCurrentSessions() {
        return __awaiter(this, void 0, void 0, function* () {
            let output;
            try {
                output = yield bash.execCommand(`tmux list-sessions -F '#S'`);
            }
            catch (error) {
                console.log('No active sessions found!');
                return;
            }
            const sessions = output.stdout.toString().trim().split('\n');
            for (const session of sessions) {
                const windows = yield bash.execCommand(`tmux list-windows -t ${session} -F "#{window_name}:#{pane_current_command}:#{pane_current_path}:#{window_layout}"`);
                const windowsArray = windows.stdout.toString().trim().split('\n');
                for (const window of windowsArray) {
                    const formattedWindow = yield this.formatWindow(window);
                    if (this.currentSessions[session]) {
                        this.currentSessions[session].windows.push(formattedWindow);
                    }
                    else {
                        this.currentSessions[session] = {
                            windows: [formattedWindow]
                        };
                    }
                }
                for (let i = 0; i < windowsArray.length; i++) {
                    const windowIndex = i;
                    const panes = yield bash.execCommand(`tmux list-panes -t ${session}:${i} -F "#{pane_current_command}:#{pane_current_path}:#{pane_left}x#{pane_top}"`);
                    const panesArray = panes.stdout.toString().trim().split('\n');
                    for (let i = 0; i < panesArray.length; i++) {
                        const pane = yield this.formatPane(panesArray[i]);
                        this.currentSessions[session].windows[windowIndex].panes.push(pane);
                    }
                }
            }
        });
    }
    checkTmuxSessionExists(sessionName) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                yield bash.execCommand(`tmux has-session -t ${sessionName}`);
                return true;
            }
            catch (error) {
                if (error instanceof Error && error.message.includes(`can't find session`)) {
                    return false;
                }
                throw new Error(`Unexpected error while checking session: ${error}`);
            }
        });
    }
    printSessions() {
        for (const sess in this.currentSessions) {
            const currentSession = this.currentSessions[sess];
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
    attachToSession(session) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.checkTmuxSessionExists(session)) {
                console.log(`Session does not exist: ${session}`);
                return;
            }
            console.log(`Attaching to tmux session: ${session}`);
            yield bash.runCommand('tmux', ['attach-session', '-t', session], {
                stdio: 'inherit',
                shell: true,
                env: Object.assign(Object.assign({}, process.env), { TMUX: '' }),
            });
        });
    }
    sourceTmuxConfig() {
        return __awaiter(this, void 0, void 0, function* () {
            const sourceTmux = `tmux source ${__dirname}/../../../tmux-files/.tmux.conf`;
            yield bash.execCommand(sourceTmux);
            console.log('Sourced tmux configuration file.');
        });
    }
    killTmuxServer() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                yield bash.execCommand('tmux kill-server');
            }
            catch (error) {
                console.log('No Server Running');
            }
        });
    }
    detachSession() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                yield bash.execCommand('tmux detach');
            }
            catch (error) {
                console.log('failed to detach');
            }
        });
    }
    formatPane(pane) {
        return __awaiter(this, void 0, void 0, function* () {
            const [currentCommand, currentPath, paneLeft, paneTop] = pane.split(':');
            const gitRepoLink = yield this.getGitRepoLink(currentPath);
            return {
                currentCommand,
                currentPath,
                gitRepoLink,
                paneLeft,
                paneTop,
            };
        });
    }
    formatWindow(window) {
        return __awaiter(this, void 0, void 0, function* () {
            const [windowName, currentCommand, currentPath, layout] = window.split(':');
            let gitRepoLink = yield this.getGitRepoLink(currentPath);
            return {
                windowName,
                layout,
                gitRepoLink,
                currentCommand,
                currentPath,
                panes: []
            };
        });
    }
    getGitRepoLink(path) {
        return __awaiter(this, void 0, void 0, function* () {
            let result = '';
            try {
                const stdout = yield bash.execCommand(`git -C ${path} remote get-url origin`);
                result = stdout.stdout;
            }
            catch (error) {
            }
            const finalResult = result.split('\n');
            return finalResult[0];
        });
    }
}
exports.BaseSessions = BaseSessions;
