import { EventEmitter } from 'events';
import * as bash from './helpers/bashHelper';
import * as toml from 'toml'
import * as fs from 'fs/promises'

export class Base {
    public events;
    public sessionsFilePath;
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

        this.sessionsFilePath = `${__dirname}/../../tmux-files/sessions`;
    }

    public async killTmuxServer(): Promise<void> {
        try {
            await bash.execCommand('tmux kill-server');
        } catch (error) {
            console.log('No Server Running');
        }
    }

    public async detachSession(): Promise<void> {
        try {
            await bash.execCommand('tmux detach');
        } catch (error) {
            console.log('failed to detach')
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
