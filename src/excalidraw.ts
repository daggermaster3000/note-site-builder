/*
 * Excalidraw drawings on the page. The Excalidraw plugin draws them as SVG;
 * without it, an SVG or PNG it auto-exported next to the drawing is used.
 */
import { App, TFile } from "obsidian";

export function isDrawing(app: App, file: TFile): boolean {
	if (file.extension === "excalidraw") return true;
	if (file.extension !== "md") return false;
	return file.name.endsWith(".excalidraw.md") ||
		app.metadataCache.getFileCache(file)?.frontmatter?.["excalidraw-plugin"] !== undefined;
}

/** The drawing's name without `.excalidraw` or `.md`, as its auto-exports are named. */
function stem(file: TFile): string {
	return file.basename.replace(/\.excalidraw$/, "");
}

/** An image Excalidraw already exported next to the drawing, if there is one. */
export function autoExport(app: App, file: TFile): TFile | null {
	const dir = file.parent && !file.parent.isRoot() ? `${file.parent.path}/` : "";
	for (const ext of ["svg", "png"]) {
		for (const name of [`${stem(file)}.${ext}`, `${stem(file)}.excalidraw.${ext}`, `${stem(file)}.light.${ext}`]) {
			const hit = app.vault.getAbstractFileByPath(dir + name);
			if (hit instanceof TFile) return hit;
		}
	}
	return null;
}

interface ExcalidrawAutomate {
	reset(): void;
	createSVG(path: string, embedFont?: boolean, settings?: object, loader?: unknown, theme?: string, padding?: number): Promise<SVGSVGElement>;
	getAPI?(): ExcalidrawAutomate;
}

/** The drawing as SVG text, light theme with a white background, or null if the Excalidraw plugin isn't running. */
export async function drawingSvg(file: TFile): Promise<string | null> {
	const global = (window as unknown as { ExcalidrawAutomate?: ExcalidrawAutomate }).ExcalidrawAutomate;
	if (!global) return null;
	const ea = global.getAPI ? global.getAPI() : global;
	ea.reset();
	const svg = await ea.createSVG(file.path, true, { withBackground: true, withTheme: true, isMask: false }, undefined, "light", 10);
	if (!svg.getAttribute("xmlns")) svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
	return `<?xml version="1.0" encoding="UTF-8"?>\n${svg.outerHTML}`;
}
