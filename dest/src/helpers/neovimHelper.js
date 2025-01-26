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
exports.saveNvimSession = saveNvimSession;
exports.loadNvimSession = loadNvimSession;
exports.openVim = openVim;
const fs = __importStar(require("fs"));
const bash = __importStar(require("../helpers/bashHelper"));
const child_process_1 = require("child_process");
function saveNvimSession(folderName, session, windowIndex, paneIndex) {
    return __awaiter(this, void 0, void 0, function* () {
        const nvimSessionsPath = `${__dirname}/../../../tmux-files/nvim-sessions`;
        const nvimSessionFileName = `${session}_${windowIndex}_${paneIndex}.vim`;
        if (!fs.existsSync(nvimSessionsPath)) {
            fs.mkdirSync(nvimSessionsPath, { recursive: true });
        }
        if (!fs.existsSync(`${nvimSessionsPath}/${folderName}`)) {
            fs.mkdirSync(`${nvimSessionsPath}/${folderName}`, { recursive: true });
        }
        if (fs.existsSync(`${nvimSessionsPath}/${folderName}/${nvimSessionFileName}`)) {
            fs.unlinkSync(`${nvimSessionsPath}/${folderName}/${nvimSessionFileName}`);
        }
        yield bash.sendKeysToTmuxTargetSession({
            sessionName: session,
            windowIndex,
            paneIndex,
            command: `:mksession ${nvimSessionsPath}/${folderName}/${nvimSessionFileName}`,
        });
    });
}
function loadNvimSession(folderName, session, windowIndex, paneIndex) {
    return __awaiter(this, void 0, void 0, function* () {
        yield bash.sendKeysToTmuxTargetSession({
            sessionName: session,
            windowIndex,
            paneIndex,
            command: `nvim -S ${__dirname}/../../../tmux-files/nvim-sessions/${folderName}/${session}_${windowIndex}_${paneIndex}.vim`,
        });
    });
}
function openVim(filePath) {
    return __awaiter(this, void 0, void 0, function* () {
        return new Promise((resolve, reject) => {
            const vimProcess = (0, child_process_1.spawn)('nvim', [filePath], {
                stdio: 'inherit',
                shell: true,
            });
            vimProcess.on('close', (code) => {
                if (code === 0) {
                    console.log('Vim exited successfully');
                    resolve();
                }
                else {
                    console.log(`Vim exited with code ${code}`);
                    reject(new Error(`Vim exited with code ${code}`));
                }
            });
            vimProcess.on('error', (err) => {
                console.error('Failed to start Vim:', err);
                reject(err);
            });
        });
    });
}
