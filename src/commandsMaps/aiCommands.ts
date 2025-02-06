import * as ai from "../AI";
import { Commands } from "./types/commandTypes";

export const aiCommands : Commands = {
    'general': ai.startNewChat,
    'load': ai.loadChat,
};
