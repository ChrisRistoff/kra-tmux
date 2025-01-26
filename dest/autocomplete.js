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
const fs_1 = __importDefault(require("fs"));
const bash = __importStar(require("./src/helpers/bashHelper"));
const os_1 = require("os");
const completionScript = `${__dirname}/../auto.sh`;
const bashrc = `${(0, os_1.homedir)()}/.bashrc`;
const zshrc = `${(0, os_1.homedir)()}/.zshrc`;
function appendToShellRc(rcFile, line) {
    if (fs_1.default.existsSync(rcFile)) {
        const content = fs_1.default.readFileSync(rcFile, 'utf8');
        if (!content.includes(line)) {
            fs_1.default.appendFileSync(rcFile, `\n${line}\n`);
            console.log(`Added autocompletion to ${rcFile}`);
        }
    }
}
const sourceLine = `source ${completionScript}`;
appendToShellRc(bashrc, sourceLine);
appendToShellRc(zshrc, sourceLine);
const sourceScriptPath = `${__dirname}/../reload.sh`;
fs_1.default.writeFileSync(sourceScriptPath, `#!/bin/bash\nsource ~/.bashrc\nsource ~/.zshrc\necho "Shell configuration reloaded."`, { mode: 0o755 });
const main = () => __awaiter(void 0, void 0, void 0, function* () {
    yield bash.execCommand(`bash ${sourceScriptPath}`);
    fs_1.default.rmSync(sourceScriptPath);
    return 'Shell configuration reloaded.';
});
main().then(res => console.log(res));
