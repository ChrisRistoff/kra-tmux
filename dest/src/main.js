#!/usr/bin/env node
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
const gitCommands_1 = require("./CommandsMaps/gitCommands");
const tmuxCommands_1 = require("./CommandsMaps/tmuxCommands");
const main = () => __awaiter(void 0, void 0, void 0, function* () {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        console.log('No argument.');
        process.exit(1);
    }
    if (args[0] === 'tmux' && tmuxCommands_1.tmuxCommands[args[1]]) {
        yield tmuxCommands_1.tmuxCommands[args[1]]();
        return;
    }
    if (args[0] === 'git' && gitCommands_1.gitCommands[args[1]]) {
        yield gitCommands_1.gitCommands[args[1]]();
        return;
    }
    console.log('Command not a command.');
});
main();
