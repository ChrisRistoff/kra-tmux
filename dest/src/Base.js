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
Object.defineProperty(exports, "__esModule", { value: true });
exports.Base = void 0;
const events_1 = require("events");
const toml = __importStar(require("toml"));
const fs = __importStar(require("fs/promises"));
class Base {
    constructor() {
        this.emitter = new events_1.EventEmitter();
        this.events = {
            emit: (event) => {
                this.emitter.emit(event);
            },
            addSyncEventListener: (event, callback = () => { }) => {
                this.emitter.addListener(event, callback);
            },
            addAsyncEventListener: (event, callback = () => __awaiter(this, void 0, void 0, function* () { })) => {
                this.emitter.addListener(event, callback);
            }
        };
    }
    setTimeout(time) {
        return __awaiter(this, void 0, void 0, function* () {
            yield new Promise(resolve => setTimeout(resolve, time));
        });
    }
    getSettings() {
        return __awaiter(this, void 0, void 0, function* () {
            const settingsFileString = yield fs.readFile(`${__dirname}/../../settings.toml`, 'utf8');
            return yield toml.parse(settingsFileString);
        });
    }
}
exports.Base = Base;
