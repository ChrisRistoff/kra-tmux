import { EventEmitter } from 'events'
import * as os from 'os';
import * as path from 'path';

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

        this.sessionsFilePath = path.join(os.homedir(), `.tmux/sessions/`);
    }
}
