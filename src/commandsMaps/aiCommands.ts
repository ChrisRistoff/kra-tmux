import * as ai from "@/AI";
import { aiAscii } from "@/AI/shared/data/ai-ascii";
import { AiCommands } from "@/commandsMaps/types/commandTypes"

export const aiCommands : AiCommands = {
    'chat': ai.startNewChat,
    'agent': ai.startAgentChat,
    'load': ai.loadChat,
    'delete': ai.deleteChats,
    'quota-agent': ai.showQuota,
    'index': ai.indexCodebase,
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
