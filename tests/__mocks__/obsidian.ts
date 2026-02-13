export class Plugin {
    app: any;
    constructor(app: any) {
        this.app = app;
    }
    onload(): Promise<void> { return Promise.resolve(); }
    onunload(): Promise<void> { return Promise.resolve(); }
    addSettingTab(tab: any): void { }
    addStatusBarItem(): any { return { setText: () => { } }; }
    addCommand(cmd: any): void { }
    registerEvent(event: any): void { }
    loadData(): Promise<any> { return Promise.resolve({}); }
    saveData(data: any): Promise<void> { return Promise.resolve(); }
}
export class App {
    vault: any;
    workspace: any;
    constructor() {
        this.vault = {
            on: () => { },
            read: () => Promise.resolve(''),
            modify: () => Promise.resolve(),
            create: () => Promise.resolve(),
            createFolder: () => Promise.resolve(),
            getAbstractFileByPath: (): any => null,
            getMarkdownFiles: (): any[] => [],
        };
        this.workspace = {
            onLayoutReady: (cb: any) => cb(),
        };
    }
}
export class TFile {
    path: string;
    extension: string;
    constructor(path: string, extension: string) {
        this.path = path;
        this.extension = extension;
    }
}
export class TAbstractFile { }
export class Notice {
    constructor(msg: string) { }
}
export const Platform = {
    isMobile: false,
};
export function normalizePath(path: string) { return path; }
export function debounce(func: any, wait: number, immediate: boolean) {
    return func;
}
export class PluginSettingTab {
    app: any;
    plugin: any;
    containerEl: any;
    constructor(app: any, plugin: any) {
        this.app = app;
        this.plugin = plugin;
        this.containerEl = {
            empty: () => { },
            createEl: () => ({ setText: () => { } }),
        };
    }
    display(): void { }
}
export class Setting {
    constructor(containerEl: any) { }
    setName(name: string): this { return this; }
    setDesc(desc: string): this { return this; }
    addText(cb: any): this { cb({ setValue: () => ({ onChange: () => { } }) }); return this; }
    addTextArea(cb: any): this { cb({ setValue: () => { }, inputEl: { style: {} }, onChange: () => { } }); return this; }
    addToggle(cb: any): this { cb({ setValue: () => ({ onChange: () => { } }) }); return this; }
}
