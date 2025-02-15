import * as ai from "../AIchat";
import { AiCommands } from "./types/commandTypes";

export const aiCommands : AiCommands = {
    'chat': ai.startNewChat,
    'load': ai.loadChat,
    'delete': ai.deleteChats,
};
