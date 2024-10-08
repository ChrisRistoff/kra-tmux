import { EventEmitter } from 'events'

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
}
