/*
 * The bits of Electron this plugin uses. Obsidian ships Electron but no types
 * for it, so the shapes are described here and checked at the one import.
 */

export interface BrowserWindow {
	loadURL(url: string): Promise<void>;
	webContents: {
		executeJavaScript(code: string): Promise<unknown>;
		printToPDF(options: object): Promise<Uint8Array>;
	};
	destroy(): void;
}

interface Electron {
	shell: {
		openExternal(url: string): Promise<void>;
		openPath(path: string): Promise<string>;
	};
	/** Obsidian exposes @electron/remote here on desktop. */
	remote?: { BrowserWindow: new (options: object) => BrowserWindow };
}

// eslint-disable-next-line @typescript-eslint/no-require-imports -- Electron is only reachable through require() inside Obsidian's renderer.
export const electron = require("electron") as Electron;
