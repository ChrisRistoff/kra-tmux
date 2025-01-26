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
exports.ManageSavedSessions = void 0;
const LoadSessions_1 = require("./LoadSessions");
const generalUI = __importStar(require("../UI/generalUI"));
const fs = __importStar(require("fs/promises"));
class ManageSavedSessions extends LoadSessions_1.LoadSessions {
    constructor() {
        super();
    }
    deleteSession() {
        return __awaiter(this, void 0, void 0, function* () {
            let savedServers = yield this.getSavedSessionsNames();
            savedServers = savedServers.filter((server) => server !== '.gitkeep');
            const fileName = yield generalUI.searchSelectAndReturnFromArray({
                prompt: "Please select a server from the list to delte",
                itemsArray: savedServers,
            });
            const filePath = `${this.sessionsFilePath}/${fileName}`;
            const sessions = yield this.getSavedSessionsByFilePath(filePath);
            this.printTargetSessions(sessions);
            const willDelete = yield generalUI.promptUserYesOrNo(`Are you sure you want to delete save ${fileName}`);
            if (willDelete) {
                yield fs.rm(filePath);
            }
        });
    }
    getSavedSessionsByFilePath(filePath) {
        return __awaiter(this, void 0, void 0, function* () {
            const latestSessions = yield fs.readFile(filePath);
            return JSON.parse(latestSessions.toString());
        });
    }
    printTargetSessions(sessions) {
        for (const sess of Object.keys(sessions)) {
            const currentSession = sessions[sess];
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
}
exports.ManageSavedSessions = ManageSavedSessions;
