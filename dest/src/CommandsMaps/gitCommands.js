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
exports.gitCommands = void 0;
const GitRestore_1 = require("../Git/GitRestore");
const GitUntracked_1 = require("../Git/GitUntracked");
const gitRestore = new GitRestore_1.GitRestore();
const gitUntracked = new GitUntracked_1.GitUntracked();
exports.gitCommands = {
    'restore': handleRestore,
    'cache-untracked': handleCacheUntracked,
    'retrieve-untracked': handleRetrieveUntracked,
};
function handleRestore() {
    return __awaiter(this, void 0, void 0, function* () {
        yield gitRestore.restoreFile();
    });
}
function handleCacheUntracked() {
    return __awaiter(this, void 0, void 0, function* () {
        yield gitUntracked.saveUntracked();
    });
}
function handleRetrieveUntracked() {
    return __awaiter(this, void 0, void 0, function* () {
        yield gitUntracked.loadUntracked();
    });
}
