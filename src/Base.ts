import { EventEmitter } from 'events';
import * as toml from 'toml'
import * as fs from 'fs/promises'

export class Base {
    public events;
    private emitter: EventEmitter= new EventEmitter();

    constructor () {
        this.events = {
            emit: (event: string) => {
                this.emitter.emit(event);
            },

            addSyncEventListener: (event: string, callback = ():void => {}) => {
                this.emitter.addListener(event, callback);
            },

            addAsyncEventListener: (event: string, callback = async (): Promise<void> => {}) => {
                this.emitter.addListener(event, callback);
            }
        }
    }

    public async debounce(time: number): Promise<void> {
        await new Promise(resolve => setTimeout(resolve, time));
    }

    public async getSettings() {
        const settingsFileString = await fs.readFile(`${__dirname}/../../tmux-files/settings.toml`, 'utf8')
        return await toml.parse(settingsFileString)
    }
}
