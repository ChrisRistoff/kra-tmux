import { EventSystem } from '../events/EventSystem';
import { SystemEvent } from '../events/SystemEvents';
import * as bash from '../helpers/bashHelper';
import * as ui from '../UI/generalUI';
import { BaseSystem } from "./BaseSystem";

export class SystemFileManager extends BaseSystem {
    private searchString?: string;
    private exactMatch?: boolean;
    private eventsHandler = new EventSystem();

    constructor() {
        super();

        this.eventsHandler.addAsyncEventListener(SystemEvent.OnGrepRequest, async () => {
            this.searchString = await this.getSearchString();
            this.exactMatch = await this.promptExactMatch();
        });
    }

    public async removeGreppedFile(): Promise<void> {
        const fileToRemove = await this.getGreppedFile();

        await bash.execCommand(`rm ${fileToRemove}`);
    }

    public async removeGreppedDir(): Promise<void> {
        const dirToRemove = await this.getGreppedDir();

        await bash.execCommand(`rm -rf ${dirToRemove}`);
    }

    private async getGreppedFile(): Promise<string> {
        await this.eventsHandler.emit(SystemEvent.OnGrepRequest);

        const files = await this.getGreppedFilesArray(this.searchString!, this.exactMatch!);

        if (!files.length) {
            return '';
        }

        const fileName = await ui.searchSelectAndReturnFromArray({
            itemsArray: files,
            prompt: 'Pick the file you want to remove:'
        });

        return fileName;
    }

    private async getGreppedDir(): Promise<string> {
        this.eventsHandler.emit(SystemEvent.OnGrepRequest);

        const files = await this.getGreppedDirsArray(this.searchString!, this.exactMatch!);

        if (!files.length) {
            return '';
        }

        const dirPath = await ui.searchSelectAndReturnFromArray({
            itemsArray: files,
            prompt: 'Pick the file you want to remove:'
        });

        return dirPath;
    }

    private async getSearchString(): Promise<string> {
        return await ui.askUserForInput('Enter a word to search for:');
    }

    private async promptExactMatch(): Promise<boolean> {
        return await ui.promptUserYesOrNo('Do you want to grep for exact match?');
    }
}
