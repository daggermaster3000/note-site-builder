/*
 * "Set up website…": one dialog that turns a folder into a website. It makes
 * or picks the home note, fills in the masthead, and optionally does the git
 * and GitHub Pages plumbing: repository, remote, deploy workflow, first push.
 */
import { App, Modal, Notice, Setting, TFile, TFolder, normalizePath } from "obsidian";
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { git } from "./git";
import { slugify } from "./render";
import type NoteSiteBuilder from "./main";

const NEW = ":new:";

interface Repo {
	/** Absolute path of the repository root, or null if the folder isn't in one yet. */
	root: string | null;
	origin: string;
	branch: string;
	/** An existing workflow that already deploys to Pages. */
	pagesWorkflow: string;
}

/** Look for a command where GUI apps can't see it: Homebrew and friends aren't on their PATH. */
function findExecutable(name: string): string | null {
	const dirs = [
		...(process.env.PATH || "").split(path.delimiter),
		"/opt/homebrew/bin", "/usr/local/bin", "/usr/bin",
		"C:\\Program Files\\GitHub CLI",
	];
	for (const dir of dirs) {
		for (const ext of process.platform === "win32" ? [".exe", ""] : [""]) {
			const candidate = path.join(dir, name + ext);
			if (dir && fs.existsSync(candidate)) return candidate;
		}
	}
	return null;
}

function run(cmd: string, args: string[], cwd?: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	const PATH = [path.dirname(cmd), "/usr/bin", "/opt/homebrew/bin", "/usr/local/bin", process.env.PATH].join(path.delimiter);
	return new Promise((resolve) => {
		execFile(cmd, args, { cwd, timeout: 120000, env: { ...process.env, PATH } }, (err, stdout, stderr) =>
			resolve({ ok: !err, stdout: String(stdout).trim(), stderr: String(stderr).trim() }));
	});
}

/** "owner/repo" from a GitHub address in any of its usual forms. */
function githubSlug(address: string): string | null {
	const m = /^(?:https?:\/\/github\.com\/|git@github\.com:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(address.trim());
	return m ? `${m[1]}/${m[2]}` : null;
}

function workflow(branch: string, sitePath: string): string {
	return `# Publishes the website built by Note Site Builder to GitHub Pages.
name: Pages

on:
  push:
    branches: [${branch}]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/upload-pages-artifact@v3
        with:
          path: ${JSON.stringify(sitePath)}
      - id: deployment
        uses: actions/deploy-pages@v4
`;
}

function starter(multi: boolean): string {
	return multi
		? `# Welcome

This is the home page. Every note in this folder becomes a page of the site,
listed in the bar at the top; link between them with [[wikilinks]].

Give a note \`site-order: 2\` to place it in the bar, or \`site-hide: true\` to
leave it out.
`
		: `# Introduction

Start writing here. Each top-level heading becomes a numbered section, with its
own entry in the contents rail.
`;
}

export class SetupModal extends Modal {
	private multi = false;
	private home = NEW;
	private noteName: string;
	private title: string;
	private eyebrow = "";
	private subtitle = "";
	private output = "site";
	private github = false;
	private createRepo = true;
	private repoName: string;
	private isPublic = true;
	private address = "";
	private publishNow = true;

	private repo: Repo = { root: null, origin: "", branch: "main", pagesWorkflow: "" };
	private gh: string | null = null;
	private ghUser = "";
	private body!: HTMLElement;

	constructor(app: App, private plugin: NoteSiteBuilder, private folder: TFolder) {
		super(app);
		const name = folder.isRoot() ? app.vault.getName() : folder.name;
		this.noteName = name;
		this.title = name;
		this.repoName = slugify(name) || "website";
	}

	private notes(): TFile[] {
		return this.folder.children
			.filter((f): f is TFile => f instanceof TFile && f.extension === "md")
			.sort((a, b) => a.basename.localeCompare(b.basename, undefined, { numeric: true }));
	}

	async onOpen() {
		this.titleEl.setText(`Set up a website from “${this.folder.isRoot() ? this.app.vault.getName() : this.folder.path}”`);
		this.modalEl.addClass("nsb-setup");
		this.body = this.contentEl.createDiv();
		this.body.createEl("p", { text: "Looking at the folder…", cls: "setting-item-description" });

		// An existing website here is edited in place rather than set up twice.
		const existingHome = this.plugin.homeIn(this.folder);
		if (existingHome) {
			this.multi = true;
			this.home = existingHome.path;
		}
		await this.inspectRepo();
		this.gh = findExecutable("gh");
		if (this.gh) {
			const who = await run(this.gh, ["api", "user", "--jq", ".login"]);
			this.ghUser = who.ok ? who.stdout : "";
		}
		this.github = !!this.repo.origin && /github\.com/.test(this.repo.origin);
		this.render();
	}

	private async inspectRepo() {
		const dir = this.plugin.abs(this.folder.isRoot() ? "" : this.folder.path);
		const top = await git(dir, "rev-parse", "--show-toplevel");
		if (!top.ok) return;
		const root = fs.realpathSync(top.stdout);
		const origin = (await git(root, "remote", "get-url", "origin")).stdout;
		const branch = (await git(root, "branch", "--show-current")).stdout || "main";
		let pagesWorkflow = "";
		const wf = path.join(root, ".github", "workflows");
		if (fs.existsSync(wf)) {
			pagesWorkflow = fs.readdirSync(wf).find((f) => /\.ya?ml$/.test(f) &&
				fs.readFileSync(path.join(wf, f), "utf8").includes("deploy-pages")) || "";
		}
		this.repo = { root, origin, branch, pagesWorkflow };
	}

	private render() {
		const el = this.body;
		el.empty();

		new Setting(el).setName("Website").setHeading();
		new Setting(el)
			.setName("Kind")
			.setDesc(this.multi
				? "Every note in this folder becomes a page, with a bar linking them."
				: "One note becomes one page, with a contents rail for its sections.")
			.addDropdown((d) => d
				.addOptions({ single: "One page", multi: "Several pages" })
				.setValue(this.multi ? "multi" : "single")
				.onChange((v) => {
					this.multi = v === "multi";
					this.render();
				}));

		const notes = this.notes();
		new Setting(el)
			.setName(this.multi ? "Home page" : "Page")
			.setDesc(this.multi ? "The note shown first, at the site's address." : "The note the page is made from.")
			.addDropdown((d) => {
				d.addOption(NEW, "New note…");
				for (const n of notes) d.addOption(n.path, n.basename);
				d.setValue(this.home).onChange((v) => {
					this.home = v;
					const note = v === NEW ? null : this.app.vault.getAbstractFileByPath(v);
					const fm = note instanceof TFile ? this.app.metadataCache.getFileCache(note)?.frontmatter : null;
					if (note instanceof TFile && fm) {
						this.title = typeof fm.title === "string" ? fm.title : note.basename;
						this.eyebrow = typeof fm.eyebrow === "string" ? fm.eyebrow : "";
						this.subtitle = typeof fm.subtitle === "string" ? fm.subtitle : "";
					}
					this.render();
				});
			});
		if (this.home === NEW) {
			new Setting(el).setName("Note name").addText((t) => t.setValue(this.noteName).onChange((v) => (this.noteName = v)));
		}

		new Setting(el).setName("Title").setDesc("The big heading at the top of the page.")
			.addText((t) => t.setValue(this.title).onChange((v) => (this.title = v)));
		new Setting(el).setName("Line above the title").setDesc("Optional. For example, the course and year.")
			.addText((t) => t.setValue(this.eyebrow).setPlaceholder("Course name · year").onChange((v) => (this.eyebrow = v)));
		new Setting(el).setName("Subtitle").setDesc("Optional, one sentence under the title.")
			.addText((t) => t.setValue(this.subtitle).onChange((v) => (this.subtitle = v)));
		new Setting(el)
			.setName("Output folder")
			.setDesc(`The built website goes in “${this.outputPath()}/”.`)
			.addText((t) => t.setValue(this.output).onChange((v) => {
				this.output = v.trim().replace(/^\/+|\/+$/g, "");
			}));

		new Setting(el).setName("Put it online").setHeading();
		new Setting(el)
			.setName("Publish with GitHub Pages")
			.setDesc("Free hosting at https://<you>.github.io/<repository>/.")
			.addToggle((t) => t.setValue(this.github).onChange((v) => {
				this.github = v;
				this.render();
			}));

		if (this.github) {
			const info = el.createEl("ul", { cls: "nsb-setup-plan" });
			info.createEl("li", {
				text: this.repo.root
					? `Uses the git repository at ${this.repo.root}.`
					: "This folder isn't in a git repository yet; one will be created here.",
			});
			if (this.repo.origin) {
				info.createEl("li", {
					text: githubSlug(this.repo.origin)
						? `Pushes to ${this.repo.origin}.`
						: `Pushes to ${this.repo.origin}. That isn't a GitHub repository, so the GitHub Pages steps are skipped.`,
				});
			} else if (this.gh && this.ghUser) {
				new Setting(el)
					.setName("Create the GitHub repository for me")
					.setDesc(`Using the GitHub CLI, signed in as ${this.ghUser}.`)
					.addToggle((t) => t.setValue(this.createRepo).onChange((v) => {
						this.createRepo = v;
						this.render();
					}));
			}
			if (!this.repo.origin && this.gh && this.ghUser && this.createRepo) {
				new Setting(el).setName("Repository name")
					.setDesc(`https://${this.ghUser.toLowerCase()}.github.io/${this.repoName}/`)
					.addText((t) => t.setValue(this.repoName).onChange((v) => (this.repoName = v.trim())));
				new Setting(el).setName("Public")
					.setDesc("Pages on a private repository needs a paid GitHub plan.")
					.addToggle((t) => t.setValue(this.isPublic).onChange((v) => (this.isPublic = v)));
			} else if (!this.repo.origin) {
				const s = new Setting(el).setName("GitHub repository")
					.addText((t) => t.setPlaceholder("https://github.com/you/my-course").setValue(this.address)
						.onChange((v) => (this.address = v.trim())));
				const desc = s.descEl;
				desc.appendText("Make an empty one at ");
				desc.createEl("a", { text: "github.com/new", href: "https://github.com/new" });
				desc.appendText(", then paste its address.");
			}
			if (!this.repo.origin || githubSlug(this.repo.origin)) info.createEl("li", {
				text: this.repo.pagesWorkflow
					? `The existing workflow ${this.repo.pagesWorkflow} already deploys to Pages, so it's left as it is.`
					: "Adds a workflow that deploys the output folder to Pages on every push.",
			});
			new Setting(el)
				.setName("Publish now")
				.setDesc("Commit the website's notes, the built site and the workflow, then push. Nothing else in the repository is committed.")
				.addToggle((t) => t.setValue(this.publishNow).onChange((v) => (this.publishNow = v)));
		}

		new Setting(el)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => b.setButtonText(this.plugin.homeIn(this.folder) ? "Update website" : "Create website").setCta()
				.onClick(async () => {
					b.setDisabled(true);
					try {
						if (await this.create()) this.close();
					} finally {
						b.setDisabled(false);
					}
				}));
	}

	private outputPath(): string {
		const base = this.folder.isRoot() ? "" : this.folder.path;
		return normalizePath(base ? `${base}/${this.output || "site"}` : this.output || "site");
	}

	private fail(message: string): false {
		new Notice(message, 12000);
		return false;
	}

	/** Do it all. Returns false, leaving the dialog open, if something needs fixing first. */
	private async create(): Promise<boolean> {
		const vault = this.app.vault;
		const out = this.outputPath();
		const base = this.folder.isRoot() ? "" : this.folder.path;
		if (!this.output || out === normalizePath(base || "/")) return this.fail("Pick an output folder inside this folder.");
		if (this.github && !this.repo.origin && !(this.gh && this.ghUser && this.createRepo) && !githubSlug(this.address)) {
			return this.fail("Paste the address of your GitHub repository, like https://github.com/you/my-course.");
		}

		// 1. The home note, and its settings in its frontmatter.
		let home: TFile;
		if (this.home === NEW) {
			const name = this.noteName.trim().replace(/[\\/:*?"<>|#^[\]]/g, "") || "Home";
			const file = normalizePath(base ? `${base}/${name}.md` : `${name}.md`);
			if (vault.getAbstractFileByPath(file)) return this.fail(`“${file}” already exists. Pick it from the list instead, or choose another name.`);
			home = await vault.create(file, starter(this.multi));
		} else {
			const picked = vault.getAbstractFileByPath(this.home);
			if (!(picked instanceof TFile)) return this.fail(`“${this.home}” no longer exists.`);
			home = picked;
		}
		// Only one home note per folder.
		if (this.multi) {
			for (const other of this.notes()) {
				if (other !== home && this.app.metadataCache.getFileCache(other)?.frontmatter?.["site-home"] === true) {
					await this.app.fileManager.processFrontMatter(other, (fm: Record<string, unknown>) => delete fm["site-home"]);
				}
			}
		}
		await this.app.fileManager.processFrontMatter(home, (fm: Record<string, unknown>) => {
			const set = (key: string, value: string) => (value.trim() ? (fm[key] = value.trim()) : delete fm[key]);
			set("title", this.title === home.basename ? "" : this.title);
			set("eyebrow", this.eyebrow);
			set("subtitle", this.subtitle);
			fm["site-folder"] = path.posix.relative(base, out) || out;
			if (this.multi) fm["site-home"] = true;
			else delete fm["site-home"];
		});
		// Let Obsidian index the new frontmatter before the build reads it.
		await new Promise<void>((resolve) => {
			const ref = this.app.metadataCache.on("changed", (f) => {
				if (f === home) {
					this.app.metadataCache.offref(ref);
					resolve();
				}
			});
			window.setTimeout(() => {
				this.app.metadataCache.offref(ref);
				resolve();
			}, 1500);
		});

		// 2. Build it.
		const built = await this.plugin.build(home, false, true);
		if (!built) return false;

		if (!this.github) {
			new Notice(`Website set up: ${built.files.size} page${built.files.size === 1 ? "" : "s"} in ${out}/.`, 6000);
			void this.plugin.openSite(home);
			return true;
		}

		// 3. Git and GitHub.
		const progress = new Notice("Setting up GitHub Pages…", 0);
		try {
			const folderAbs = this.plugin.abs(base);
			let root: string | null = this.repo.root;
			if (!root) {
				const init = await git(folderAbs, "init", "-b", "main");
				if (!init.ok) return this.fail(`git init failed: ${init.stderr}`);
				root = fs.realpathSync(folderAbs);
				this.repo.branch = "main";
			}
			let slug = githubSlug(this.repo.origin);
			if (!this.repo.origin) {
				if (this.gh && this.ghUser && this.createRepo) {
					const made = await run(this.gh, ["repo", "create", this.repoName, this.isPublic ? "--public" : "--private",
						"--source", root, "--remote", "origin"], root);
					if (!made.ok) return this.fail(`Couldn't create the GitHub repository: ${made.stderr.split("\n").pop()}`);
					slug = `${this.ghUser}/${this.repoName}`;
				} else {
					slug = githubSlug(this.address);
					const add = await git(root, "remote", "add", "origin", `https://github.com/${slug}.git`);
					if (!add.ok) return this.fail(`git remote add failed: ${add.stderr}`);
				}
			}

			const vaultRoot = fs.realpathSync(this.plugin.basePath());
			const siteRel = path.relative(root, path.join(vaultRoot, out)).split(path.sep).join("/");
			const wfFile = path.join(root, ".github", "workflows", "pages.yml");
			const written: string[] = [];
			if (!this.repo.pagesWorkflow && slug) {
				if (fs.existsSync(wfFile)) return this.fail(".github/workflows/pages.yml already exists; move it aside or remove it first.");
				fs.mkdirSync(path.dirname(wfFile), { recursive: true });
				fs.writeFileSync(wfFile, workflow(this.repo.branch, siteRel));
				written.push(".github/workflows/pages.yml");
			}

			if (!this.publishNow) {
				progress.hide();
				new Notice("Website set up. Run “Publish with Git” when you're ready to put it online.", 8000);
				return true;
			}

			// 4. First publish: the site's notes, the built site and the workflow.
			const paths = [...built.site.pages.map((p) => p.path), out]
				.map((p) => path.relative(root, path.join(vaultRoot, p)).split(path.sep).join("/"))
				.concat(written);
			for (const step of [["add", "-A", "--", ...paths], ["commit", "-m", "Set up website", "--", ...paths]]) {
				const res = await git(root, ...step);
				if (!res.ok && !/nothing to commit|no changes added/.test(res.stdout + res.stderr)) {
					return this.fail(`git ${step[0]} failed: ${(res.stderr || res.stdout).split("\n").pop()}`);
				}
			}
			const push = await git(root, "push", "--set-upstream", "origin", "HEAD");
			if (!push.ok) return this.fail(`git push failed: ${push.stderr.split("\n").pop()}`);

			if (!slug) {
				progress.hide();
				new Notice(`Website set up and pushed to ${this.repo.origin}.`, 8000);
				return true;
			}

			// 5. Turn Pages on, set to deploy from the workflow, and run it once.
			const settings = `https://github.com/${slug}/settings/pages`;
			let pagesOn = false;
			if (this.gh && this.ghUser && slug) {
				const api = (method: string) => run(this.gh!, ["api", "-X", method, `repos/${slug}/pages`, "-f", "build_type=workflow"], root);
				pagesOn = (await api("POST")).ok || (await api("PUT")).ok;
				if (pagesOn) await run(this.gh, ["workflow", "run", "pages.yml", "--ref", this.repo.branch], root);
			}
			const [owner, name] = (slug || "/").split("/");
			const url = `https://${owner.toLowerCase()}.github.io/${name}/`;
			progress.hide();
			if (pagesOn) {
				new Notice(`Published. The site goes live in a minute or two at\n${url}`, 15000);
			} else {
				new Notice(`Pushed. One step left: on GitHub, set Settings → Pages → Source to “GitHub Actions”. Opening that page now. The site will then be at\n${url}`, 20000);
				this.plugin.open(settings);
			}
			return true;
		} finally {
			progress.hide();
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}
