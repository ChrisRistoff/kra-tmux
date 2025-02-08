import * as ai from "../AIchat";
import { Commands } from "./types/commandTypes";

export const aiCommands : Commands = {
    'chat': ai.startNewChat,
    'load': ai.loadChat,
    'delete': ai.deleteChats,
};
