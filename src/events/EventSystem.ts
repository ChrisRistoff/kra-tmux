import { EventEmitter } from 'events';

export class EventSystem {
    private emitter: EventEmitter= new EventEmitter();

    public async emit(event: string): Promise<void> {
        const promises = this.emitter.listeners(event).map(listener => {
            try {
                const result = listener();
                return result instanceof Promise ? result : Promise.resolve();
            } catch (err) {
                return Promise.reject(err);
            }
        });

        return Promise.all(promises).then(() => {});
    }

    public addSyncEventListener(event: string, callback = ():void => {}): void {
        this.emitter.addListener(event, () => {
            callback();
        });
    }

    public async addAsyncEventListener(event: string, callback = async (): Promise<void> => {}): Promise<void> {
        this.emitter.addListener(event, async () => {
             await callback();
        });
    }
};
