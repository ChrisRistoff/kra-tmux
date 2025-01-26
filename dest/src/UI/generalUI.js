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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.promptUserYesOrNo = promptUserYesOrNo;
exports.askUserForInput = askUserForInput;
exports.searchAndSelect = searchAndSelect;
exports.searchSelectAndReturnFromArray = searchSelectAndReturnFromArray;
const inquirer_1 = __importDefault(require("inquirer"));
const inquirer_autocomplete_prompt_1 = __importDefault(require("inquirer-autocomplete-prompt"));
inquirer_1.default.registerPrompt('autocomplete', inquirer_autocomplete_prompt_1.default);
function promptUserYesOrNo(message) {
    return __awaiter(this, void 0, void 0, function* () {
        const { proceed } = yield inquirer_1.default.prompt([
            {
                type: 'confirm',
                name: 'proceed',
                message,
                default: true,
            },
        ]);
        return proceed;
    });
}
function askUserForInput(message) {
    return __awaiter(this, void 0, void 0, function* () {
        const { name } = yield inquirer_1.default.prompt([
            {
                type: 'input',
                name: 'name',
                message,
            },
        ]);
        return name;
    });
}
function searchAndSelect(options) {
    return __awaiter(this, void 0, void 0, function* () {
        console.log(options.itemsArray);
        let currentUserInput;
        const { userSelection } = yield inquirer_1.default.prompt([
            {
                type: 'autocomplete',
                name: 'userSelection',
                message: options.prompt,
                source: (_answersSoFar, input) => __awaiter(this, void 0, void 0, function* () {
                    if (!input) {
                        return options.itemsArray;
                    }
                    currentUserInput = input;
                    const searchTerm = input.toLowerCase();
                    const filtered = options.itemsArray.filter(option => option.toLowerCase().includes(searchTerm));
                    if (filtered.length === 0) {
                        return [input];
                    }
                    return filtered;
                }),
                pageSize: 20,
            },
        ]);
        if (!currentUserInput || userSelection === currentUserInput) {
            return userSelection;
        }
        const { finalChoice } = yield inquirer_1.default.prompt([
            {
                type: 'list',
                name: 'finalChoice',
                message: `Which one do you want to use for the name of your save?`,
                choices: [
                    { name: `Use your input: "${currentUserInput}"`, value: currentUserInput },
                    { name: `Use your selection: ${userSelection}`, value: userSelection }
                ],
            },
        ]);
        return finalChoice;
    });
}
function searchSelectAndReturnFromArray(options) {
    return __awaiter(this, void 0, void 0, function* () {
        const { selectedOption } = yield inquirer_1.default.prompt([
            {
                type: 'autocomplete',
                name: 'selectedOption',
                message: options.prompt,
                source: (_answersSoFar, input) => {
                    if (!input) {
                        return options.itemsArray;
                    }
                    const searchTerm = input.toLowerCase();
                    return options.itemsArray.filter(option => option.toLowerCase().includes(searchTerm));
                },
                pageSize: 20,
            },
        ]);
        return selectedOption;
    });
}
