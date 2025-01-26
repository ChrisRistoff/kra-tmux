"use strict";
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
exports.runCommand = runCommand;
exports.execCommand = execCommand;
exports.sendKeysToTmuxTargetSession = sendKeysToTmuxTargetSession;
const child_process_1 = require("child_process");
const allowedCommandsForNoCode = {
    'tmux': new Set(['attach-session', 'has-session', 'kill-server']),
    'git': new Set(['get-url'])
};
function runCommand(command_1, args_1) {
    return __awaiter(this, arguments, void 0, function* (command, args, options = {}) {
        return new Promise((resolve, reject) => {
            const process = (0, child_process_1.spawn)(command, args, options);
            process.on('close', (code) => {
                if (code === 0) {
                    resolve();
                }
                else if (isCommandValidWithNoCode(command, args)) {
                    resolve();
                }
                else {
                    reject(new Error(`Command "${command} ${args === null || args === void 0 ? void 0 : args.join(' ')}" failed with code ${code}`));
                }
            });
            process.on('error', reject);
        });
    });
}
;
function execCommand(command) {
    return __awaiter(this, void 0, void 0, function* () {
        return new Promise((resolve, reject) => {
            (0, child_process_1.exec)(command, (error, stdout, stderr) => {
                if (error) {
                    reject(error);
                }
                else {
                    resolve({ stdout, stderr });
                }
            });
        });
    });
}
;
function isCommandValidWithNoCode(command, args) {
    if (!allowedCommandsForNoCode[command]) {
        return false;
    }
    if (!args) {
        return false;
    }
    for (let i = 0; i < allowedCommandsForNoCode[command].size; i++) {
        if (allowedCommandsForNoCode[command].has(args[i])) {
            return true;
        }
    }
    return false;
}
function sendKeysToTmuxTargetSession(options) {
    return __awaiter(this, void 0, void 0, function* () {
        let commandString = 'tmux send-keys';
        const windowIndexIsValid = typeof options.windowIndex === 'number';
        const paneIndexIsValid = typeof options.paneIndex === 'number';
        if (options.sessionName || windowIndexIsValid || paneIndexIsValid) {
            commandString += ' -t ';
        }
        if (options.sessionName) {
            commandString += options.sessionName;
        }
        if (windowIndexIsValid) {
            commandString += commandString[commandString.length - 1] === ' '
                ? options.windowIndex
                : `:${options.windowIndex}`;
        }
        if (paneIndexIsValid) {
            commandString += commandString[commandString.length - 1] === ' '
                ? options.paneIndex
                : `.${options.paneIndex}`;
        }
        commandString += ` "${options.command}" C-m`;
        yield execCommand(commandString);
    });
}
