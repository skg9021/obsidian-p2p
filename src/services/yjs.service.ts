import * as Y from 'yjs';
import { App, TFile, TAbstractFile, debounce } from 'obsidian';

export class YjsService {
    ydoc: Y.Doc;
    yMap: Y.Map<Y.Text>;
    isRemoteUpdate: boolean = false;
    private onUpdateCallback: (update: Uint8Array) => void = () => { };

    constructor(private app: App) {
        this.ydoc = new Y.Doc();
        this.yMap = this.ydoc.getMap('obsidian-vault');

        this.ydoc.on('update', (update, origin) => {
            if (origin !== 'local') {
                this.applyToDisk();
                this.onUpdateCallback(update);
            }
        });
    }

    setUpdateCallback(callback: (update: Uint8Array) => void) {
        this.onUpdateCallback = callback;
    }

    destroy() {
        this.ydoc.destroy();
    }

    async handleLocalModify(file: TAbstractFile) {
        if (this.isRemoteUpdate) return;
        if (!(file instanceof TFile) || file.extension !== 'md') return;

        const content = await this.app.vault.read(file);

        this.ydoc.transact(() => {
            let yText = this.yMap.get(file.path);
            if (!yText) { yText = new Y.Text(); this.yMap.set(file.path, yText); }

            const yContent = yText.toString();
            if (yContent !== content) {
                yText.delete(0, yText.length);
                yText.insert(0, content);
            }
        }, 'local');

        const update = Y.encodeStateAsUpdate(this.ydoc);
        this.onUpdateCallback(update);
    }

    applyToDisk = debounce(async () => {
        this.isRemoteUpdate = true;
        try {
            for (const [path, yText] of this.yMap.entries()) {
                const content = (yText as Y.Text).toString();
                const file = this.app.vault.getAbstractFileByPath(path);
                if (file instanceof TFile) {
                    const current = await this.app.vault.read(file);
                    if (current !== content) await this.app.vault.modify(file, content);
                } else if (!file) {
                    await this.ensureFolder(path);
                    await this.app.vault.create(path, content);
                }
            }
        } catch (e) { console.error("Sync Write Error", e); }
        finally { this.isRemoteUpdate = false; }
    }, 500, true);

    async syncLocalToYjs() {
        const files = this.app.vault.getMarkdownFiles();
        this.ydoc.transact(() => {
            files.forEach(async (file) => {
                const content = await this.app.vault.read(file);
                let yText = this.yMap.get(file.path);
                if (!yText) { yText = new Y.Text(); this.yMap.set(file.path, yText); }
                if (yText.toString() !== content) { yText.delete(0, yText.length); yText.insert(0, content); }
            });
        }, 'local');
    }

    async ensureFolder(path: string) {
        const parts = path.split('/');
        parts.pop();
        let current = '';
        for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current);
        }
    }

    applyUpdate(uint8: Uint8Array) {
        Y.applyUpdate(this.ydoc, uint8, 'remote');
    }

    get stateVector() {
        return Y.encodeStateVector(this.ydoc);
    }

    encodeStateAsUpdate(targetStateVector?: Uint8Array) {
        return Y.encodeStateAsUpdate(this.ydoc, targetStateVector);
    }
}
