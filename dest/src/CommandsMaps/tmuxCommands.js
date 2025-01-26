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
exports.tmuxCommands = void 0;
const LoadSessions_1 = require("../Sessions/LoadSessions");
const ManageSavedSessions_1 = require("../Sessions/ManageSavedSessions");
const SaveSessions_1 = require("../Sessions/SaveSessions");
const nvim = __importStar(require("../helpers/neovimHelper"));
const toml = __importStar(require("toml"));
const fs = __importStar(require("fs/promises"));
const saveSession = new SaveSessions_1.Save();
const loadSessions = new LoadSessions_1.LoadSessions();
const manageSessions = new ManageSavedSessions_1.ManageSavedSessions();
exports.tmuxCommands = {
    'settings': handleChangeSettings,
    'save-server': handleSaveSessions,
    'load-server': handleLoadSession,
    'list-sessions': handlePrintSessions,
    'delete-session': handleDeleteSession,
    'kill': handleKillTmuxServer,
};
function handleChangeSettings() {
    return __awaiter(this, void 0, void 0, function* () {
        const settingsFilePath = `~/programming/settings.toml`;
        let settingsFileString = yield fs.readFile(`${__dirname}/../../settings.toml`, 'utf8');
        const oldSettings = yield toml.parse(settingsFileString);
        yield nvim.openVim(settingsFilePath);
        settingsFileString = yield fs.readFile(`${__dirname}/../../settings.toml`, 'utf8');
        const newSettings = yield toml.parse(settingsFileString);
        console.log('Changed settings below:');
        for (const setting of Object.keys(oldSettings)) {
            if (oldSettings[setting] !== newSettings[setting]) {
                console.table({
                    'Setting': setting
                });
                console.table({
                    'Old value': `${oldSettings[setting]}`,
                    'New setting': `${newSettings[setting]}`
                });
            }
        }
    });
}
function handleSaveSessions() {
    return __awaiter(this, void 0, void 0, function* () {
        yield saveSession.saveSessionsToFile();
    });
}
function handleLoadSession() {
    return __awaiter(this, void 0, void 0, function* () {
        yield loadSessions.handleSessionsIfServerIsRunning();
        yield loadSessions.loadLatestSession();
    });
}
function handlePrintSessions() {
    return __awaiter(this, void 0, void 0, function* () {
        yield manageSessions.setCurrentSessions();
        manageSessions.printSessions();
    });
}
function handleDeleteSession() {
    return __awaiter(this, void 0, void 0, function* () {
        yield manageSessions.deleteSession();
    });
}
function handleKillTmuxServer() {
    return __awaiter(this, void 0, void 0, function* () {
        yield manageSessions.killTmuxServer();
    });
}
