import {
	App, FileSystemAdapter, FuzzySuggestModal, MarkdownView, Menu, Modal, Notice, Plugin, PluginSettingTab,
	Setting, TAbstractFile, TFile, TFolder, normalizePath,
} from "obsidian";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { IMAGE_EXT, render, slugify } from "./render";
import { printToPdf } from "./pdf";
import { git, pagesUrl, version } from "./git";
import { LaserSuggest, laserLivePreview, laserPostProcessor } from "./laser-editor";

interface Settings {
	outputFolder: string;
	placeholders: boolean;
	pageSize: string;
	port: number;
	openAfterBuild: boolean;
	/** What Publish includes besides the note and its site, unless a note has its own choice. */
	publishScope: "site" | "folder" | "repo";
	/** Per note: the extra folders it publishes (vault paths, "" for the vault root, REPO for the whole repository). */
	publishFolders: Record<string, string[]>;
}

/** Stands for the whole repository in a publish selection. */
const REPO = ":repo:";

const DEFAULTS: Settings = {
	outputFolder: "{{folder}}/{{slug}}-site",
	placeholders: true,
	pageSize: "A4",
	port: 8321,
	openAfterBuild: false,
	publishScope: "site",
	publishFolders: {},
};

interface Built {
	note: TFile;
	/** Vault-relative output folder. */
	folder: string;
	pdfName: string;
	/** Files the page embeds, so the preview can rebuild when one changes. */
	sources: Set<string>;
	warnings: string[];
}

const RELOAD = `<script>(function(){var s=new EventSource("/__reload");s.onmessage=function(){location.reload()}})()</script>`;

export default class NoteSiteBuilder extends Plugin {
	settings: Settings = DEFAULTS;
	private statusEl!: HTMLElement;
	private busy = false;
	private preview: {
		server: http.Server;
		clients: Set<http.ServerResponse>;
		built: Built;
		port: number;
		timer?: number;
	} | null = null;

	async onload() {
		this.settings = Object.assign({}, DEFAULTS, await this.loadData());
		this.settings.publishFolders = { ...this.settings.publishFolders };

		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("nsb-status");
		this.statusEl.onClickEvent((evt) => this.showMenu(evt));
		this.refreshStatus();

		this.addRibbonIcon("globe", "Build website from note", (evt) => this.showMenu(evt));

		const withNote = (fn: (note: TFile) => unknown) => (checking: boolean) => {
			const note = this.activeNote();
			if (!note) return false;
			if (!checking) fn(note);
			return true;
		};
		this.addCommand({ id: "build", name: "Build website from current note", checkCallback: withNote((n) => this.build(n, false)) });
		this.addCommand({ id: "build-pdf", name: "Build website and PDF from current note", checkCallback: withNote((n) => this.build(n, true)) });
		this.addCommand({ id: "preview", name: "Start or stop live preview", callback: () => this.togglePreview() });
		this.addCommand({ id: "open", name: "Open built website", checkCallback: withNote((n) => this.openSite(n)) });
		this.addCommand({ id: "open-pdf", name: "Open built PDF", checkCallback: withNote((n) => this.openPdf(n)) });
		this.addCommand({ id: "publish", name: "Publish with git (commit and push)", checkCallback: withNote((n) => this.publish(n)) });
		this.addCommand({ id: "open-published", name: "Open published website (GitHub Pages)", checkCallback: withNote((n) => this.openPublished(n)) });

		this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
			if (!(file instanceof TFile) || file.extension !== "md") return;
			menu.addItem((i) => i.setTitle("Build website").setIcon("globe").onClick(() => this.build(file, false)));
		}));
		this.registerEvent(this.app.vault.on("modify", (file) => this.onModify(file)));

		// `/laser{488}` shows as a coloured chip in Obsidian too.
		this.registerMarkdownPostProcessor(laserPostProcessor);
		this.registerEditorExtension(laserLivePreview);
		this.registerEditorSuggest(new LaserSuggest(this.app));

		this.addSettingTab(new SettingsTab(this.app, this));
	}

	onunload() {
		this.stopPreview(true);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// ---------- helpers ----------

	private activeNote(): TFile | null {
		const file = this.app.workspace.getActiveFile();
		return file && file.extension === "md" ? file : null;
	}

	private basePath(): string {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) throw new Error("This vault isn't on the local disk.");
		return adapter.getBasePath();
	}

	private abs(vaultPath: string): string {
		return path.join(this.basePath(), vaultPath);
	}

	/** The note's output folder: its `site-folder:` frontmatter, else the pattern in settings. */
	outputFolder(note: TFile): string {
		const parent = note.parent && note.parent.path !== "/" ? note.parent.path : "";
		const fm = this.app.metadataCache.getFileCache(note)?.frontmatter;
		const custom = typeof fm?.["site-folder"] === "string" ? fm["site-folder"].trim() : "";
		const folder = custom
			? (custom.startsWith("/") ? custom.slice(1) : path.posix.join(parent, custom))
			: this.settings.outputFolder
				.replace(/\{\{folder\}\}/g, parent)
				.replace(/\{\{name\}\}/g, note.basename)
				.replace(/\{\{slug\}\}/g, slugify(note.basename) || "site");
		const out = normalizePath(folder.replace(/^\/+/, ""));
		if (!out || out === "/" || out === normalizePath(parent || "/")) {
			throw new Error("The output folder can't be the vault root or the note's own folder.");
		}
		return out;
	}

	private pdfName(note: TFile): string {
		return `${slugify(note.basename) || "page"}.pdf`;
	}

	private refreshStatus() {
		if (this.busy) this.statusEl.setText("Building website…");
		else if (this.preview) this.statusEl.setText(`● Preview :${this.preview.port}`);
		else this.statusEl.setText("");
		this.statusEl.toggle(this.busy || !!this.preview);
		this.statusEl.setAttr("aria-label", this.preview ? `Previewing “${this.preview.built.note.basename}”` : "");
	}

	private showMenu(evt: MouseEvent) {
		const note = this.activeNote();
		const menu = new Menu();
		const item = (title: string, icon: string, fn: () => unknown, enabled = true) =>
			menu.addItem((i) => i.setTitle(title).setIcon(icon).setDisabled(!enabled).onClick(fn));
		item("Build website", "hammer", () => note && this.build(note, false), !!note);
		item("Build website and PDF", "file-down", () => note && this.build(note, true), !!note);
		item(this.preview ? "Stop live preview" : "Start live preview", this.preview ? "square" : "play",
			() => this.togglePreview(), !!note || !!this.preview);
		menu.addSeparator();
		item("Open built website", "globe", () => note && this.openSite(note), !!note);
		item("Open built PDF", "file-text", () => note && this.openPdf(note), !!note);
		menu.addSeparator();
		item("Publish with git…", "upload-cloud", () => note && this.publish(note), !!note);
		item("Open published website", "external-link", () => note && this.openPublished(note), !!note);
		menu.showAtMouseEvent(evt);
	}

	private open(target: string) {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { shell } = require("electron");
		if (/^https?:/.test(target)) shell.openExternal(target);
		else shell.openPath(target);
	}

	// ---------- building ----------

	/** Build the page (and optionally the PDF). Returns what was built, or null on failure. */
	async build(note: TFile, withPdf: boolean, quiet = false): Promise<Built | null> {
		if (this.busy) {
			new Notice("A build is already running.");
			return null;
		}
		this.busy = true;
		this.refreshStatus();
		const progress = quiet ? null : new Notice(withPdf ? "Building website and PDF…" : "Building website…", 0);
		try {
			// Obsidian saves edits on a short delay; write them out first.
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (view && view.file === note) await view.save();
			const built = await this.buildPage(note);
			if (withPdf) {
				try {
					await printToPdf(this.abs(path.posix.join(built.folder, "index.html")), this.abs(path.posix.join(built.folder, built.pdfName)));
				} catch (err) {
					built.warnings.push(`PDF not made: ${(err as Error).message}`);
				}
			}
			progress?.hide();
			if (!quiet) {
				const w = built.warnings;
				new Notice(
					`Built “${note.basename}” into ${built.folder}/` +
						(w.length ? `\n${w.length} warning(s):\n• ${w.slice(0, 5).join("\n• ")}` : ""),
					w.length ? 12000 : 4000,
				);
				if (w.length) console.warn("[note-site-builder]", w.join("\n"));
				if (this.settings.openAfterBuild) this.open(this.abs(path.posix.join(built.folder, withPdf ? built.pdfName : "index.html")));
			}
			return built;
		} catch (err) {
			progress?.hide();
			console.error("[note-site-builder] build failed", err);
			new Notice(`Website build failed: ${(err as Error).message}`, 12000);
			return null;
		} finally {
			this.busy = false;
			this.refreshStatus();
		}
	}

	private async buildPage(note: TFile): Promise<Built> {
		const adapter = this.app.vault.adapter;
		const folder = this.outputFolder(note);
		const figures = `${folder}/figures`;
		const markdown = await this.app.vault.read(note);

		// Each image is copied once, under a name that is safe in a URL.
		const copies = new Map<string, string>(); // source path -> page src
		const taken = new Set<string>();
		const sources = new Set<string>([note.path]);
		const resolveImage = (link: string): string | null => {
			const file = this.app.metadataCache.getFirstLinkpathDest(link.split("#")[0], note.path);
			if (!file || !IMAGE_EXT.has(`.${file.extension.toLowerCase()}`)) return null;
			sources.add(file.path);
			let src = copies.get(file.path);
			if (!src) {
				const stem = file.basename.replace(/[^\w.-]+/g, "-");
				let name = `${stem}.${file.extension}`;
				for (let n = 2; taken.has(name); n++) name = `${stem}-${n}.${file.extension}`;
				taken.add(name);
				src = `figures/${name}`;
				copies.set(file.path, src);
			}
			return src;
		};

		const cwd = this.abs(note.parent?.path || "");
		const stamp = await version(cwd);
		const pdfName = this.pdfName(note);
		const result = render({
			markdown,
			fallbackTitle: note.basename,
			resolveImage,
			placeholders: this.settings.placeholders,
			pdfName,
			pageSize: this.settings.pageSize,
			versionHtml: stamp.html,
			versionText: stamp.text,
		});

		if (!(await adapter.exists(folder))) await adapter.mkdir(folder);
		if (copies.size && !(await adapter.exists(figures))) await adapter.mkdir(figures);
		for (const [from, src] of copies) {
			const to = `${folder}/${src}`;
			const file = this.app.vault.getAbstractFileByPath(from);
			if (!(file instanceof TFile) || from === to) continue;
			const existing = await adapter.stat(to);
			if (existing && existing.mtime >= file.stat.mtime && existing.size === file.stat.size) continue;
			await adapter.writeBinary(to, await this.app.vault.readBinary(file));
		}
		await adapter.write(`${folder}/index.html`, result.html);
		return { note, folder, pdfName, sources, warnings: result.warnings };
	}

	// ---------- live preview ----------

	async togglePreview() {
		if (this.preview) return this.stopPreview();
		const note = this.activeNote();
		if (!note) return new Notice("Open the note you want to preview first.");
		const built = await this.build(note, false, true);
		if (!built) return;

		const port = this.settings.port;
		const clients = new Set<http.ServerResponse>();
		const server = http.createServer((req, res) => this.serve(req, res, clients));
		server.on("error", (err: NodeJS.ErrnoException) => {
			this.preview = null;
			this.refreshStatus();
			new Notice(err.code === "EADDRINUSE"
				? `Port ${port} is in use. Pick another in Settings → Note Site Builder.`
				: `Live preview failed: ${err.message}`, 10000);
		});
		server.listen(port, "127.0.0.1", () => {
			new Notice(`Previewing “${note.basename}” at http://localhost:${port}. It reloads each time you save.`);
			this.open(`http://localhost:${port}/`);
		});
		this.preview = { server, clients, built, port };
		this.refreshStatus();
	}

	private serve(req: http.IncomingMessage, res: http.ServerResponse, clients: Set<http.ServerResponse>) {
		if (!this.preview) return res.end();
		const url = decodeURIComponent((req.url || "/").split("?")[0]);
		if (url === "/__reload") {
			res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
			res.write("retry: 1000\n\n");
			clients.add(res);
			req.on("close", () => clients.delete(res));
			return;
		}
		const root = this.abs(this.preview.built.folder);
		const file = path.join(root, url.endsWith("/") ? `${url}index.html` : url);
		if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
			res.writeHead(404);
			return res.end("Not found");
		}
		const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
		res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
		if (type.startsWith("text/html")) {
			res.end(fs.readFileSync(file, "utf8").replace("</body>", `${RELOAD}</body>`));
		} else {
			fs.createReadStream(file).pipe(res);
		}
	}

	private onModify(file: TAbstractFile) {
		const p = this.preview;
		if (!p || !p.built.sources.has(file.path)) return;
		window.clearTimeout(p.timer);
		p.timer = window.setTimeout(async () => {
			if (this.preview !== p) return;
			try {
				p.built = await this.buildPage(p.built.note);
				for (const c of p.clients) c.write("data: reload\n\n");
			} catch (err) {
				new Notice(`Preview rebuild failed: ${(err as Error).message}`, 8000);
			}
		}, 400);
	}

	stopPreview(quiet = false) {
		const p = this.preview;
		if (!p) return;
		window.clearTimeout(p.timer);
		for (const c of p.clients) c.end();
		p.server.close();
		this.preview = null;
		this.refreshStatus();
		if (!quiet) new Notice("Live preview stopped.");
	}

	// ---------- opening ----------

	async openSite(note: TFile) {
		if (this.preview?.built.note === note) return this.open(`http://localhost:${this.preview.port}/`);
		const page = `${this.outputFolder(note)}/index.html`;
		if (!(await this.app.vault.adapter.exists(page)) && !(await this.build(note, false))) return;
		this.open(this.abs(page));
	}

	async openPdf(note: TFile) {
		const pdf = `${this.outputFolder(note)}/${this.pdfName(note)}`;
		if (!(await this.app.vault.adapter.exists(pdf))) {
			const built = await this.build(note, true);
			if (!built || !(await this.app.vault.adapter.exists(pdf))) return;
		}
		this.open(this.abs(pdf));
	}

	async openPublished(note: TFile) {
		const url = await pagesUrl(this.abs(note.parent?.path || ""));
		if (!url) return new Notice("This note isn't in a git repository with a GitHub remote.");
		this.open(url);
	}

	// ---------- publishing ----------

	async publish(note: TFile) {
		const cwd = this.abs(note.parent?.path || "");
		const top = await git(cwd, "rev-parse", "--show-toplevel");
		if (!top.ok) return new Notice("This note isn't in a git repository, so there's nothing to push to.");
		const repo = fs.realpathSync(top.stdout);
		const base = fs.realpathSync(this.basePath());
		const built = await this.build(note, false, true);
		if (!built) return;

		/** A selection entry as a path git understands, relative to the repository root. */
		const pathspec = (entry: string) => {
			if (entry === REPO) return ".";
			const rel = path.relative(repo, path.join(base, entry));
			return rel === "" ? "." : rel;
		};
		const inRepo = (entry: string) => {
			const rel = path.relative(repo, path.join(base, entry));
			return !rel.startsWith("..") && !path.isAbsolute(rel);
		};

		// The note's folder and each folder above it, up to the top of the repository.
		const ancestors: string[] = [];
		for (let f: TFolder | null = note.parent; f; f = f.parent) {
			const entry = f.isRoot() ? "" : f.path;
			if (!inRepo(entry)) break;
			ancestors.push(entry);
		}
		const repoAboveVault = path.relative(repo, base) !== "" && inRepo("");
		const candidates = [...ancestors, ...(repoAboveVault ? [REPO] : [])];

		const saved = this.settings.publishFolders[note.path];
		const scope = this.settings.publishScope;
		const initial = (saved ?? (scope === "folder" ? [ancestors[0]] : scope === "repo" ? [REPO] : []))
			.filter((e) => e === REPO || inRepo(e));

		// The note and its site are always published; the rest is up to the selection.
		const always = [path.relative(repo, path.join(base, note.path)), path.relative(repo, path.join(base, built.folder))];
		const specs = (selection: string[]) => [...new Set([...always, ...selection.map(pathspec)])];
		const preview = async (selection: string[]) => {
			const status = (await git(repo, "status", "--porcelain", "--untracked-files=all", "--", ...specs(selection))).stdout;
			const upstream = await git(repo, "rev-list", "--count", "@{upstream}..HEAD");
			return { status, ahead: upstream.ok ? Number(upstream.stdout) : 0, hasUpstream: upstream.ok };
		};

		new PublishModal(this.app, {
			vaultName: this.app.vault.getName(),
			repoName: path.basename(repo),
			candidates,
			initial,
			preview,
			folderInRepo: (f) => inRepo(f.isRoot() ? "" : f.path),
			onSubmit: async (message, selection) => {
				this.settings.publishFolders[note.path] = selection;
				await this.saveSettings();
				const progress = new Notice("Publishing…", 0);
				const { status, hasUpstream } = await preview(selection);
				const paths = specs(selection);
				const steps: string[][] = status ? [["add", "-A", "--", ...paths], ["commit", "-m", message, "--", ...paths]] : [];
				steps.push(hasUpstream ? ["push"] : ["push", "--set-upstream", "origin", "HEAD"]);
				for (const step of steps) {
					const res = await git(repo, ...step);
					if (!res.ok) {
						progress.hide();
						console.error("[note-site-builder] git", step.join(" "), res.stderr);
						return new Notice(`git ${step[0]} failed:\n${(res.stderr || res.stdout).split("\n").slice(-3).join("\n")}`, 15000);
					}
				}
				progress.hide();
				const url = await pagesUrl(repo);
				new Notice(`Pushed.${url ? ` If GitHub Pages is set up, the site updates shortly at\n${url}` : ""}`, 10000);
			},
		}).open();
	}
}

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
	".webp": "image/webp", ".svg": "image/svg+xml", ".avif": "image/avif", ".bmp": "image/bmp",
	".pdf": "application/pdf",
};

interface PublishOptions {
	vaultName: string;
	repoName: string;
	/** The note's folder and those above it, nearest first; maybe REPO. */
	candidates: string[];
	initial: string[];
	preview: (selection: string[]) => Promise<{ status: string; ahead: number; hasUpstream: boolean }>;
	folderInRepo: (folder: TFolder) => boolean;
	onSubmit: (message: string, selection: string[]) => void;
}

class PublishModal extends Modal {
	private selected: Set<string>;
	/** Folders on offer: the candidates, then any others added by hand. */
	private offered: string[];
	private listEl!: HTMLElement;
	private changesEl!: HTMLElement;
	private summaryEl!: HTMLElement;
	private publishButton: HTMLButtonElement | null = null;
	private message = "Update website";
	private request = 0;

	constructor(app: App, private opts: PublishOptions) {
		super(app);
		this.selected = new Set(opts.initial);
		this.offered = [...opts.candidates, ...opts.initial.filter((e) => !opts.candidates.includes(e))];
	}

	private label(entry: string): string {
		if (entry === REPO) return `Whole repository (${this.opts.repoName})`;
		return entry === "" ? `Whole vault (${this.opts.vaultName})` : entry;
	}

	onOpen() {
		const { contentEl } = this;
		this.titleEl.setText("Publish with git");
		this.modalEl.addClass("nsb-publish");

		new Setting(contentEl).setName("What to publish").setHeading();
		new Setting(contentEl)
			.setName("This note and its website")
			.setDesc("Always included.")
			.addToggle((t) => t.setValue(true).setDisabled(true));
		this.listEl = contentEl.createDiv();
		this.renderFolders();
		new Setting(contentEl).addButton((b) => b.setButtonText("Add another folder…").onClick(() => {
			new FolderPicker(this.app, this.opts.folderInRepo, (folder) => {
				const entry = folder.isRoot() ? "" : folder.path;
				if (!this.offered.includes(entry)) this.offered.push(entry);
				this.selected.add(entry);
				this.renderFolders();
				this.refresh();
			}).open();
		}));

		this.summaryEl = contentEl.createEl("p");
		this.changesEl = contentEl.createEl("pre", { cls: "nsb-changes" });

		new Setting(contentEl).setName("Commit message").addText((t) => {
			t.setValue(this.message).onChange((v) => (this.message = v));
			t.inputEl.addClass("nsb-wide");
			window.setTimeout(() => t.inputEl.select(), 0);
		});
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => {
				this.publishButton = b.buttonEl;
				b.setButtonText("Publish").setCta().onClick(() => {
					this.close();
					this.opts.onSubmit(this.message.trim() || "Update website", [...this.selected]);
				});
			});
		this.refresh();
	}

	private renderFolders() {
		this.listEl.empty();
		const nearest = this.opts.candidates[0];
		for (const entry of this.offered) {
			const desc = entry === REPO
				? "Everything in the repository, including files outside this vault."
				: entry === nearest ? "The note's own folder, and everything in it." : "Everything in this folder.";
			new Setting(this.listEl)
				.setName(this.label(entry))
				.setDesc(desc)
				.addToggle((t) => t.setValue(this.selected.has(entry)).onChange((on) => {
					if (on) this.selected.add(entry);
					else this.selected.delete(entry);
					this.refresh();
				}));
		}
	}

	/** Show what the current selection would commit; only the latest request counts. */
	private async refresh() {
		const ticket = ++this.request;
		this.summaryEl.setText("Checking for changes…");
		const { status, ahead } = await this.opts.preview([...this.selected]);
		if (ticket !== this.request) return;
		const files = status ? status.split("\n").length : 0;
		this.summaryEl.setText(
			files
				? `${files} changed file${files === 1 ? "" : "s"} will be committed and pushed:`
				: ahead
					? `No new edits here, but ${ahead} commit${ahead === 1 ? " hasn't" : "s haven't"} been pushed yet. They will be pushed now.`
					: "Nothing to publish in this selection: no changes since the last push.",
		);
		this.changesEl.setText(status);
		this.changesEl.toggle(!!status);
		if (this.publishButton) this.publishButton.disabled = !files && !ahead;
	}

	onClose() {
		this.request++;
		this.contentEl.empty();
	}
}

class FolderPicker extends FuzzySuggestModal<TFolder> {
	constructor(app: App, private allowed: (f: TFolder) => boolean, private onPick: (f: TFolder) => void) {
		super(app);
		this.setPlaceholder("Folder to publish…");
	}
	getItems(): TFolder[] {
		return this.app.vault.getAllLoadedFiles()
			.filter((f): f is TFolder => f instanceof TFolder && this.allowed(f));
	}
	getItemText(f: TFolder): string {
		return f.isRoot() ? "/" : f.path;
	}
	onChooseItem(f: TFolder) {
		this.onPick(f);
	}
}

class SettingsTab extends PluginSettingTab {
	constructor(app: App, private plugin: NoteSiteBuilder) {
		super(app, plugin);
	}

	display() {
		const { containerEl } = this;
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();
		containerEl.empty();

		new Setting(containerEl)
			.setName("Output folder")
			.setDesc("Where each note's website is written, in the vault. {{folder}} is the note's folder, {{name}} its name and {{slug}} its name made URL-safe. A note can override this with a site-folder: property.")
			.addText((t) => t.setPlaceholder(DEFAULTS.outputFolder).setValue(s.outputFolder).onChange(async (v) => {
				s.outputFolder = v.trim() || DEFAULTS.outputFolder;
				await save();
			}));

		new Setting(containerEl)
			.setName("Mark empty sections")
			.setDesc("Show a “to be written” box under headings that have nothing under them yet.")
			.addToggle((t) => t.setValue(s.placeholders).onChange(async (v) => {
				s.placeholders = v;
				await save();
			}));

		new Setting(containerEl)
			.setName("Open after building")
			.setDesc("Open the page (or the PDF) in your browser after each build.")
			.addToggle((t) => t.setValue(s.openAfterBuild).onChange(async (v) => {
				s.openAfterBuild = v;
				await save();
			}));

		new Setting(containerEl)
			.setName("PDF page size")
			.addDropdown((d) => d
				.addOptions({ A4: "A4", letter: "US Letter", A5: "A5", "A4 landscape": "A4 landscape", "letter landscape": "US Letter landscape" })
				.setValue(s.pageSize)
				.onChange(async (v) => {
					s.pageSize = v;
					await save();
				}));

		new Setting(containerEl)
			.setName("Publish by default")
			.setDesc("What Publish with git includes besides the note and its website. You can change it for each note in the Publish dialog, and that choice is remembered.")
			.addDropdown((d) => d
				.addOptions({ site: "Only the note and its website", folder: "The note's whole folder", repo: "The whole repository" })
				.setValue(s.publishScope)
				.onChange(async (v) => {
					s.publishScope = v as Settings["publishScope"];
					await save();
				}));

		const remembered = Object.keys(s.publishFolders).length;
		if (remembered) {
			new Setting(containerEl)
				.setName("Remembered publish choices")
				.setDesc(`${remembered} note${remembered === 1 ? " has its" : "s have their"} own selection of folders.`)
				.addButton((b) => b.setButtonText("Forget them").onClick(async () => {
					s.publishFolders = {};
					await save();
					this.display();
				}));
		}

		new Setting(containerEl)
			.setName("Live preview port")
			.setDesc("The preview is served at http://localhost:<port>.")
			.addText((t) => t.setValue(String(s.port)).onChange(async (v) => {
				const n = Number(v);
				if (Number.isInteger(n) && n > 1023 && n < 65536) {
					s.port = n;
					await save();
				}
			}));
	}
}
