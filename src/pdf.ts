/*
 * Print a built page to PDF. Pagination, running heads and page numbers come
 * from the page's own print stylesheet, so the PDF matches the browser's
 * print dialog.
 *
 * Obsidian's own Chromium does the printing, in a hidden window. If that
 * isn't available, an installed Chrome is run headless instead.
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";

import { electron } from "./electron";

/** Wait for web fonts and KaTeX to settle before printing. */
const SETTLE = `
	Promise.race([
		document.fonts.ready,
		new Promise((r) => setTimeout(r, 10000)),
	]).then(() => new Promise((r) => setTimeout(r, 400)))
`;

export async function printToPdf(page: string, out: string): Promise<void> {
	const remote = electron.remote;
	if (remote && remote.BrowserWindow) {
		const win = new remote.BrowserWindow({ show: false, width: 1100, height: 1400 });
		try {
			await win.loadURL(pathToFileURL(page).href);
			await win.webContents.executeJavaScript(SETTLE);
			const data = await win.webContents.printToPDF({
				printBackground: true,
				preferCSSPageSize: true,
				generateDocumentOutline: true,
			});
			await fs.promises.writeFile(out, data);
		} finally {
			win.destroy();
		}
		return;
	}
	const chrome = findChrome();
	if (!chrome) throw new Error("no way to print: Obsidian's printer is unavailable and Chrome wasn't found");
	await chromePdf(chrome, page, out);
}

const CANDIDATES = [
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
	"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
	"/usr/bin/google-chrome",
	"/usr/bin/google-chrome-stable",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
];

function findChrome(): string | null {
	return CANDIDATES.find((p) => fs.existsSync(p)) || null;
}

/**
 * Chrome sometimes writes the file and then lingers instead of exiting, so a
 * PDF that has stopped growing counts as done and the process is killed.
 */
function chromePdf(chrome: string, page: string, out: string, timeout = 120000): Promise<void> {
	return new Promise((resolve, reject) => {
		fs.rmSync(out, { force: true });
		const proc = spawn(chrome, [
			"--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
			"--virtual-time-budget=20000", "--no-pdf-header-footer",
			"--generate-pdf-document-outline", `--print-to-pdf=${out}`,
			pathToFileURL(path.resolve(page)).href,
		], { stdio: "ignore" });
		const started = Date.now();
		let lastSize = -1;
		let stableSince = Date.now();
		const finish = (err?: Error) => {
			window.clearInterval(timer);
			if (proc.exitCode === null) proc.kill("SIGKILL");
			const ok = fs.existsSync(out) && fs.statSync(out).size > 0;
			if (err || !ok) reject(err || new Error("Chrome produced no PDF"));
			else resolve();
		};
		const timer = window.setInterval(() => {
			if (Date.now() - started > timeout) return finish(new Error("Chrome timed out printing"));
			const size = fs.existsSync(out) ? fs.statSync(out).size : -1;
			if (size > 0 && size === lastSize) {
				if (Date.now() - stableSince > 3000) finish();
			} else {
				lastSize = size;
				stableSince = Date.now();
			}
		}, 500);
		proc.on("exit", () => finish());
		proc.on("error", (err) => finish(err));
	});
}
