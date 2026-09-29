/* Git helpers: provenance for the page, and publishing. All optional. */
import { execFile } from "child_process";

export interface Result {
	ok: boolean;
	stdout: string;
	stderr: string;
}

export function git(cwd: string, ...args: string[]): Promise<Result> {
	return new Promise((resolve) => {
		execFile("git", ["-C", cwd, ...args], { timeout: 60000, maxBuffer: 1 << 24 }, (err, stdout, stderr) =>
			resolve({ ok: !err, stdout: String(stdout).trim(), stderr: String(stderr).trim() }));
	});
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Turn the origin remote into a browsable base URL, ssh or https. */
async function repoUrl(cwd: string): Promise<string> {
	const remote = (await git(cwd, "remote", "get-url", "origin")).stdout;
	const m = /^(?:git@([^:]+):|https:\/\/(?:[^@/]+@)?([^/]+)\/)(.+?)(?:\.git)?$/.exec(remote);
	return m ? `https://${m[1] || m[2]}/${m[3]}` : "";
}

/** https://<owner>.github.io/<repo>/ when origin is on GitHub. */
export async function pagesUrl(cwd: string): Promise<string> {
	const m = /^https:\/\/github\.com\/([^/]+)\/(.+)$/.exec(await repoUrl(cwd));
	return m ? `https://${m[1].toLowerCase()}.github.io/${m[2]}/` : "";
}

/** The commit a page was built from: HTML for the masthead, text for the printed running head. */
export async function version(cwd: string): Promise<{ html: string; text: string }> {
	const log = await git(cwd, "log", "-1", "--format=%h%n%cs%n%s");
	if (!log.ok || !log.stdout) return { html: "", text: "" };
	const [sha, date, subject = ""] = log.stdout.split("\n");
	const dirty = (await git(cwd, "status", "--porcelain")).stdout ? " + uncommitted changes" : "";
	const base = await repoUrl(cwd);
	const code = `<code>${escapeHtml(sha)}</code>`;
	const label = base ? `<a href="${escapeHtml(`${base}/commit/${sha}`)}">${code}</a>` : code;
	return {
		html: `<p class="version">${label} · ${escapeHtml(date)}<span>${escapeHtml(subject + dirty)}</span></p>`,
		text: `${sha} · ${date}`,
	};
}
