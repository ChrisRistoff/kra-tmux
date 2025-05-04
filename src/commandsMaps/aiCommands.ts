import { aiAscii } from "@/AIchat/data/ai-ascii";
import * as ai from "../AIchat";
import { AiCommands } from "./types/commandTypes";

export const aiCommands : AiCommands = {
    'chat': ai.startNewChat,
    'load': ai.loadChat,
    'delete': ai.deleteChats,
};

export function handleAiCommandNotExist(commandName: string): void {
    if (Object.keys(aiCommands).includes(commandName)) {
        return;
    }

    console.log(aiAscii);

    if (commandName) {
        console.table({[`${commandName}`]: 'Is not a valid command'});
    }

    process.exit(1);
}
