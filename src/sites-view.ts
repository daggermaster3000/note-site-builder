/* The Websites panel: every site in the vault, with its actions one click away. */
import { ItemView, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type NoteSiteBuilder from "./main";
import type { Site } from "./main";

export const SITES_VIEW = "note-site-builder-sites";

function ago(time: number): string {
	const s = Math.max(0, (Date.now() - time) / 1000);
	if (s < 60) return "just now";
	const [n, unit] = s < 3600 ? [s / 60, "minute"] : s < 86400 ? [s / 3600, "hour"] : [s / 86400, "day"];
	const k = Math.floor(n);
	return `${k} ${unit}${k === 1 ? "" : "s"} ago`;
}

export class SitesView extends ItemView {
	private urls = new Map<string, Promise<string>>();

	constructor(leaf: WorkspaceLeaf, private plugin: NoteSiteBuilder) {
		super(leaf);
	}

	getViewType() {
		return SITES_VIEW;
	}

	getDisplayText() {
		return "Websites";
	}

	getIcon() {
		return "globe";
	}

	async onOpen() {
		this.refresh();
	}

	refresh() {
		const el = this.contentEl;
		el.empty();
		el.addClass("nsb-sites");

		const head = el.createDiv({ cls: "nsb-sites-head" });
		head.createEl("h4", { text: "Websites" });
		const tools = head.createDiv({ cls: "nsb-sites-tools" });
		this.iconButton(tools, "plus", "Set up a new website", () => this.plugin.setup());
		this.iconButton(tools, "refresh-cw", "Refresh", () => {
			this.urls.clear();
			this.refresh();
		});

		const sites = this.plugin.allSites();
		if (!sites.length) {
			const empty = el.createDiv({ cls: "nsb-sites-empty" });
			empty.createEl("p", { text: "No websites yet." });
			empty.createEl("p", { text: "Right-click a folder and choose “Set up website…”, or build one from any note." });
			return;
		}
		for (const site of sites) this.card(el, site);
	}

	private card(parent: HTMLElement, site: Site) {
		const card = parent.createDiv({ cls: "nsb-site" });
		const title = card.createDiv({ cls: "nsb-site-title" });
		const link = title.createEl("a", { text: this.plugin.pageTitle(site.home), href: "#" });
		link.addEventListener("click", (e) => {
			e.preventDefault();
			void this.app.workspace.getLeaf(false).openFile(site.home);
		});
		title.createSpan({
			cls: "nsb-site-badge",
			text: site.root ? `${site.pages.length} page${site.pages.length === 1 ? "" : "s"}` : "one page",
		});

		const where = site.root ? (site.root.isRoot() ? "/" : site.root.path) : site.home.path;
		card.createDiv({ cls: "nsb-site-meta", text: `${where} → ${site.folder}/` });

		const status = card.createDiv({ cls: "nsb-site-meta" });
		const index = this.app.vault.getAbstractFileByPath(`${site.folder}/index.html`);
		const previewing = this.plugin.previewFolder() === site.folder;
		status.setText(
			(index instanceof TFile ? `Built ${ago(index.stat.mtime)}` : "Not built yet") +
				(previewing ? " · previewing" : ""),
		);
		if (previewing) status.addClass("nsb-site-live");

		const url = card.createDiv({ cls: "nsb-site-meta" });
		void this.publishedUrl(site).then((address) => {
			if (!address) return;
			const a = url.createEl("a", { text: address.replace(/^https:\/\//, ""), href: address });
			a.addEventListener("click", (e) => {
				e.preventDefault();
				this.plugin.open(address);
			});
		});

		const actions = card.createDiv({ cls: "nsb-site-actions" });
		this.iconButton(actions, "hammer", "Build", () => this.plugin.build(site.home, false));
		this.iconButton(actions, "file-down", "Build with PDF", () => this.plugin.build(site.home, true));
		this.iconButton(actions, previewing ? "square" : "play", previewing ? "Stop live preview" : "Live preview",
			() => this.plugin.togglePreview(site.home));
		this.iconButton(actions, "globe", "Open website", () => this.plugin.openSite(site.home));
		this.iconButton(actions, "upload-cloud", "Publish with Git", () => this.plugin.publish(site.home));
		const folder = site.root ?? site.home.parent;
		if (folder) this.iconButton(actions, "settings", "Website settings", () => this.plugin.setup(folder));
	}

	private publishedUrl(site: Site): Promise<string> {
		const dir = site.home.parent?.path ?? "";
		let url = this.urls.get(dir);
		if (!url) {
			url = this.plugin.publishedUrl(site.home);
			this.urls.set(dir, url);
		}
		return url;
	}

	private iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => unknown) {
		const button = parent.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
		setIcon(button, icon);
		button.addEventListener("click", () => onClick());
		return button;
	}
}
