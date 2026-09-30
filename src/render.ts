/*
 * Turn one Obsidian note into a single-page site: numbered sections, a
 * contents rail, captioned and numbered figures, KaTeX maths and a print
 * stylesheet. Pure string work — nothing here touches Obsidian or the disk,
 * so it can be tested on its own.
 */
import { Marked } from "marked";
import { markedSmartypants } from "marked-smartypants";
import TEMPLATE from "./template.html";
import { LASER, laserHtml } from "./laser";

export const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".bmp"]);

export interface RenderOptions {
	/** The note's text, frontmatter included. */
	markdown: string;
	/** Used when the frontmatter has no `title:`. */
	fallbackTitle: string;
	/**
	 * Map an embedded or linked image to the `src` it should have on the page,
	 * or null if it can't be found. Called once per image, in page order.
	 */
	resolveImage: (link: string) => string | null;
	/**
	 * Map a link to another note to its page on the site ("other.html"), or
	 * null when that note isn't published, in which case the link becomes
	 * plain text. Leave out for a one-page site.
	 */
	resolveNote?: (link: string) => string | null;
	/** Links to the site's other pages, shown above the masthead. */
	siteNavHtml?: string;
	/** Mark headings with nothing under them as "to be written". */
	placeholders: boolean;
	/** File name of the PDF the Download button offers. */
	pdfName: string;
	/** CSS `@page` size, e.g. "A4" or "letter". */
	pageSize: string;
	/** Provenance shown under the masthead (HTML) and in the printed running head (text). */
	versionHtml?: string;
	versionText?: string;
}

export interface RenderResult {
	html: string;
	title: string;
	warnings: string[];
}

// ---------- small helpers ----------

export function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function unescapeHtml(text: string): string {
	return text
		.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

function stripTags(text: string): string {
	return text.replace(/<[^>]+>/g, "");
}

export function slugify(text: string): string {
	return unescapeHtml(stripTags(text))
		.toLowerCase()
		.trim()
		.replace(/[^\p{L}\p{N}_\s-]/gu, "")
		.replace(/[\s_]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function cssString(text: string): string {
	return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
}

/** Read a `---` frontmatter block: flat `key: value` pairs are all we need. */
export function splitFrontmatter(md: string): { meta: Record<string, string>; body: string } {
	const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(md);
	if (!m) return { meta: {}, body: md };
	const meta: Record<string, string> = {};
	for (const line of m[1].split(/\r?\n/)) {
		if (!line.includes(":") || /^[\s#]/.test(line)) continue;
		const at = line.indexOf(":");
		meta[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
	}
	return { meta, body: md.slice(m[0].length) };
}

/**
 * Apply `fn` to the parts of the note that are prose, leaving fenced code
 * blocks and inline code spans exactly as written.
 */
function outsideCode(md: string, fn: (text: string) => string): string {
	const out: string[] = [];
	const lines = md.split("\n");
	let fence: string | null = null;
	let prose: string[] = [];
	const flush = () => {
		if (!prose.length) return;
		const text = prose.join("\n");
		// Inline code spans are left alone too.
		out.push(text.split(/(`+[^`\n]*?`+)/).map((part, i) => (i % 2 ? part : fn(part))).join(""));
		prose = [];
	};
	for (const line of lines) {
		const f = /^\s*(`{3,}|~{3,})/.exec(line);
		if (fence) {
			out.push(line);
			if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
			continue;
		}
		if (f) {
			flush();
			fence = f[1];
			out.push(line);
			continue;
		}
		prose.push(line);
	}
	flush();
	return out.join("\n");
}

// ---------- //hidden and //answer ----------

const HIDDEN = /\s*\/\/hidden\s*$/i;
// An answer runs from its marker to the end of the line.
const ANSWER = /(?:^|\s)\/\/answer\b.*$/i;

/**
 * Drop headings marked `//hidden` with everything beneath them, down to the
 * next heading of the same or higher level; a bare `//hidden` line hides only
 * itself. `//answer` hides the rest of its line. Code blocks are left alone.
 */
export function stripHidden(md: string): string {
	const out: string[] = [];
	let fence: string | null = null;
	let skipLevel = 0;

	for (const line of md.split("\n")) {
		const f = /^\s*(```+|~~~+)/.exec(line);
		if (f) {
			const token = f[1][0];
			fence = fence && token === fence ? null : fence || token;
		}
		if (fence) {
			if (!skipLevel) out.push(line);
			continue;
		}
		const heading = /^(#{1,6})\s/.exec(line);
		if (skipLevel) {
			// Stay inside the hidden block until a heading climbs back out.
			if (heading && heading[1].length <= skipLevel) skipLevel = 0;
			else continue;
		}
		if (HIDDEN.test(line)) {
			if (heading) skipLevel = heading[1].length;
			continue;
		}
		let kept = line;
		if (ANSWER.test(kept)) {
			kept = kept.replace(ANSWER, "").trimEnd();
			if (!kept.trim()) continue;
		}
		out.push(kept);
	}
	return out.join("\n");
}

// ---------- the renderer ----------

class Renderer {
	warnings: string[] = [];
	private math: string[] = [];
	private marked: Marked;

	constructor(private opts: RenderOptions) {
		this.marked = new Marked({ gfm: true }, markedSmartypants());
		this.marked.use({
			renderer: {
				// Task list items get a class so the bullet can be dropped.
				listitem(item) {
					if (!item.task) return false;
					return `<li class="task">${this.parser.parse(item.tokens)}</li>\n`;
				},
			},
		});
	}

	/** One line of markdown (a title, a caption), maths included. */
	inline(text: string): string {
		const math: string[] = [];
		const stashed = text.replace(/(?<![\\$])\$(?!\s)([^\n$]+?)(?<!\s)\$(?!\$)/g, (_m, expr: string) => {
			math.push(expr);
			return `xinlinemathx${math.length - 1}x`;
		});
		return (this.marked.parseInline(stashed) as string)
			.replace(/xinlinemathx(\d+)x/g, (_m, n: string) => `\\(${escapeHtml(math[Number(n)])}\\)`);
	}

	/** Hide $$...$$ and $...$ from the markdown parser. */
	private stashMath(md: string): string {
		return outsideCode(md, (text) =>
			text
				.replace(/\$\$([\s\S]+?)\$\$/g, (_m, expr: string) =>
					`\n\n<div class="mathblock">\\[${escapeHtml(expr.trim())}\\]</div>\n\n`)
				.replace(/(?<![\\$])\$(?!\s)([^\n$]+?)(?<!\s)\$(?!\$)/g, (_m, expr: string) => {
					this.math.push(expr);
					return `xmathx${this.math.length - 1}x`;
				}),
		);
	}

	private restoreMath(html: string): string {
		return html.replace(/xmathx(\d+)x/g, (_m, n: string) => `\\(${escapeHtml(this.math[Number(n)])}\\)`);
	}

	/** Obsidian-only inline syntax: comments, highlights, lasers, wikilinks. */
	private obsidianInline(md: string): string {
		return outsideCode(md, (text) =>
			text
				// %% comments %% never reach the page.
				.replace(/%%[\s\S]*?%%/g, "")
				.replace(/==(?=\S)([^=\n]+?)==/g, "<mark>$1</mark>")
				.replace(LASER, (_m, nm: string) => laserHtml(Number(nm)))
				// [[#Heading]] is an in-page link. A link to another page of the site
				// goes to that page; links to notes that aren't published become plain text.
				.replace(/(?<!!)\[\[([^\]|#]*)(?:#\^?([^\]|]+))?(?:\|([^\]]+))?\]\]/g,
					(_m, note: string, heading: string | undefined, label: string | undefined) => {
						const anchor = heading ? `#${slugify(heading)}` : "";
						if (!note.trim() && heading) return `[${(label || heading).trim()}](${anchor})`;
						const text = (label || (heading ? `${note} › ${heading}` : note)).trim();
						const href = this.opts.resolveNote?.(note.trim());
						return href ? `[${text}](${href}${anchor})` : text;
					})
				// Markdown-style links to notes, as Obsidian writes them with wikilinks off.
				.replace(/(?<!!)\[([^\]]*)\]\(<?([^)#>]+?\.md)>?(#[^)]*)?\)/g,
					(whole, text: string, target: string, hash: string | undefined) => {
						if (/^[a-z]+:/i.test(target)) return whole;
						const href = this.opts.resolveNote?.(safeDecode(target).replace(/\.md$/, ""));
						const anchor = hash ? `#${slugify(safeDecode(hash.slice(1)))}` : "";
						return href ? `[${text}](${href}${anchor})` : text;
					}),
		);
	}

	/** `> [!note] Title` callouts become boxes whose body is still markdown. */
	private callouts(md: string): string {
		const lines = md.split("\n");
		const out: string[] = [];
		for (let i = 0; i < lines.length; i++) {
			const head = /^>\s*\[!([\w-]+)\][+-]?\s*(.*)$/.exec(lines[i]);
			if (!head) {
				out.push(lines[i]);
				continue;
			}
			const type = head[1].toLowerCase();
			const title = head[2].trim() || type.charAt(0).toUpperCase() + type.slice(1);
			const body: string[] = [];
			while (i + 1 < lines.length && /^>/.test(lines[i + 1])) body.push(lines[++i].replace(/^>\s?/, ""));
			out.push(
				"",
				`<div class="callout" data-callout="${escapeHtml(type)}">`,
				`<p class="callout-title">${this.inline(title)}</p>`,
				"",
				this.callouts(body.join("\n")),
				"",
				"</div>",
				"",
			);
		}
		return out.join("\n");
	}

	/**
	 * Image embeds become <figure>s. The caption is the next non-blank line
	 * when that line is wholly bold or wholly italic, or else text after the
	 * pipe that isn't a size.
	 */
	private figures(md: string): string {
		const lines = md.split("\n");
		const out: string[] = [];
		const embed = /^!\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]\s*$/;
		const mdimg = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/;
		let fence: string | null = null;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const f = /^\s*(```+|~~~+)/.exec(line);
			if (f) fence = fence && f[1][0] === fence ? null : fence || f[1][0];
			const e = !fence && embed.exec(line.trim());
			const m = !fence && !e && mdimg.exec(line.trim());
			if (!e && !m) {
				out.push(fence ? line : this.inlineEmbeds(line));
				continue;
			}
			let width = "";
			let inlineCaption = "";
			let src: string | null;
			let alt: string;
			if (e) {
				const name = e[1].trim();
				const pipe = (e[2] || "").trim();
				if (!IMAGE_EXT.has(extname(name))) {
					this.warnings.push(`embed of “${name}” isn't an image, so it was left out`);
					continue;
				}
				// Obsidian uses the pipe for display size (400 or 400x300);
				// anything else there is a caption.
				const size = /^(\d+)(?:x\d+)?$/.exec(pipe);
				if (size) width = ` style="width:${size[1]}px"`;
				else inlineCaption = pipe;
				src = this.image(name);
				alt = inlineCaption || name.replace(/\.[^.]+$/, "");
			} else {
				const img = m as RegExpExecArray;
				const raw = img[2].trim().replace(/^<|>$/g, "").replace(/\s+"[^"]*"$/, "");
				alt = inlineCaption = img[1].trim();
				src = /^(https?:|data:)/.test(raw) ? raw : this.image(safeDecode(raw));
			}
			if (src === null) continue;

			let caption = inlineCaption;
			let j = i + 1;
			while (j < lines.length && !lines[j].trim()) j++;
			if (j < lines.length) {
				const cm = /^(?:\*\*(.+)\*\*|\*([^*].*)\*|_([^_].*)_)$/.exec(lines[j].trim());
				if (cm) {
					caption = (cm[1] || cm[2] || cm[3]).trim();
					i = j;
				}
			}
			// "Figure 3. " prefixes are added by CSS; strip a hand-typed one.
			caption = caption.replace(/^Fig(?:ure)?\.?\s*\d+\s*[.:—–-]?\s*/i, "");
			const capHtml = caption ? this.inline(caption) : "";
			if (capHtml) alt = stripTags(capHtml);
			out.push(
				`<figure${width}>`,
				`<img src="${escapeHtml(src)}" alt="${escapeHtml(unescapeHtml(alt))}">`,
				...(capHtml ? [`<figcaption>${capHtml}</figcaption>`] : []),
				"</figure>",
				"",
			);
		}
		return out.join("\n");
	}

	/** An image embedded mid-sentence stays inline, without a figure. */
	private inlineEmbeds(line: string): string {
		return line.replace(/!\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g, (whole, name: string, pipe = "") => {
			if (!IMAGE_EXT.has(extname(name))) return "";
			const src = this.image(name.trim());
			if (src === null) return "";
			const size = /^(\d+)/.exec(pipe.trim());
			return `<img src="${escapeHtml(src)}" alt=""${size ? ` width="${size[1]}"` : ""}>`;
		});
	}

	private image(link: string): string | null {
		const src = this.opts.resolveImage(link);
		if (src === null) this.warnings.push(`missing image: ${link}`);
		return src;
	}

	/**
	 * Section headings are the note's top heading level. A note that starts
	 * at ## has its headings lifted so that ## becomes the section level.
	 */
	private liftHeadings(md: string): string {
		let min = 7;
		outsideCode(md, (text) => {
			for (const m of text.matchAll(/^(#{1,6})\s/gm)) min = Math.min(min, m[1].length);
			return text;
		});
		if (min <= 1 || min > 6) return md;
		return outsideCode(md, (text) => text.replace(/^(#{1,6})(?=\s)/gm, (h) => "#".repeat(h.length - min + 1)));
	}

	preprocess(body: string): string {
		let md = body.replace(/\r\n/g, "\n");
		// The Automatic Table Of Contents block; the rail replaces it.
		md = md.replace(/^```(?:table-of-contents|toc)\n[\s\S]*?^```\n?/gm, "");
		md = stripHidden(md);
		md = this.liftHeadings(md);
		md = this.stashMath(md);
		md = this.figures(md);
		md = this.callouts(md);
		md = this.obsidianInline(md);
		return md;
	}

	/** Split the flat heading stream into numbered <section>s and a nav tree. */
	sections(body: string): { content: string; toc: string } {
		const TODO = '<p class="todo">this section has not been written yet.</p>';
		const used = new Map<string, number>();
		const uniqueId = (text: string) => {
			const base = slugify(text) || "section";
			const n = used.get(base) || 0;
			used.set(base, n + 1);
			return n ? `${base}-${n}` : base;
		};

		const parts = body.split(/(?=<h1\b)/).filter((p) => p.trim());
		const sections: string[] = [];
		const nav: string[] = [];
		let n = 0;

		for (const part of parts) {
			const m = /^<h1[^>]*>([\s\S]*?)<\/h1>/.exec(part);
			// Anything before the first heading opens the page, unnumbered.
			if (!m) {
				sections.push(`<section class="intro">\n${part.trim()}\n</section>`);
				continue;
			}
			n++;
			const title = m[1];
			const sid = uniqueId(title);
			const subs: [string, string][] = [];
			let rest = part.slice(m[0].length).replace(
				/<h([2-6])[^>]*>([\s\S]*?)<\/h\1>/g,
				(_mm, level: string, text: string) => {
					const hid = uniqueId(text);
					if (level === "2") subs.push([hid, text]);
					return `<h${level} id="${hid}">${text}</h${level}>`;
				},
			);
			if (this.opts.placeholders) {
				// A heading followed by a deeper one is not empty: its subsections are its body.
				rest = rest.replace(
					/<\/h([2-6])>(\s*)(?=<h([2-6])|$)/g,
					(whole, level: string, gap: string, next?: string) =>
						next && Number(next) > Number(level) ? whole : `</h${level}>\n${TODO}${gap}`,
				);
				if (!rest.trim()) rest = TODO;
			}
			const num = String(n).padStart(2, "0");
			sections.push(
				`<section aria-labelledby="${sid}">\n` +
					`<h2 class="sec" id="${sid}"><span class="num">${num}</span><span>${title}</span></h2>\n` +
					`${rest.trim()}\n</section>`,
			);
			const kids = subs.map(([h, t]) => `<li><a href="#${h}">${t}</a></li>`).join("");
			nav.push(
				`<li><a href="#${sid}"><span class="num">${n}</span><span>${title}</span></a>` +
					(kids ? `<ol>${kids}</ol>` : "") +
					"</li>",
			);
		}
		return { content: sections.join("\n\n"), toc: `<ol>\n${nav.join("\n")}\n</ol>` };
	}

	render(): RenderResult {
		const { meta, body } = splitFrontmatter(this.opts.markdown);
		const title = meta.title || this.opts.fallbackTitle;
		let html = this.marked.parse(this.preprocess(body), { async: false }) as string;
		let { content, toc } = this.sections(html);
		content = this.restoreMath(content);
		// Wide tables scroll inside their own box rather than pushing the page out.
		content = content.replace(/<table>/g, '<div class="tablewrap"><table>').replace(/<\/table>/g, "</table></div>");
		// On paper a heading, or a bold label line, travels with the table under it.
		content = content.replace(
			/((?:<h([2-6])(?![^>]*class="sec")[^>]*>(?:(?!<\/h\2>)[\s\S])*<\/h\2>|<p><strong>(?:(?!<\/p>)[\s\S])*<\/strong><\/p>)\s*<div class="tablewrap">(?:(?!<\/table>)[\s\S])*<\/table><\/div>)/g,
			'<div class="keep">$1</div>',
		);

		const optional = (field: string, tag: string, cls: string) => {
			const text = (meta[field] || "").trim();
			return text ? `<${tag} class="${cls}">${this.inline(text)}</${tag}>` : "";
		};
		const plainTitle = unescapeHtml(stripTags(this.inline(title)));
		const button =
			`<a class="pdf-button" href="${escapeHtml(this.opts.pdfName)}" download>` +
			'<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" ' +
			'stroke-width="1.5"><path d="M8 2v8m0 0-3-3m3 3 3-3M3 13h10"/></svg>' +
			"Download PDF</a>";

		const fields: Record<string, string> = {
			"{{PDF_BUTTON}}": button,
			"{{PAGE_SIZE}}": this.opts.pageSize,
			"{{PRINT_TITLE}}": cssString(plainTitle),
			"{{PRINT_VERSION}}": cssString(this.opts.versionText || ""),
			"{{TITLE}}": escapeHtml(plainTitle),
			"{{EYEBROW}}": optional("eyebrow", "p", "eyebrow"),
			"{{HEADING}}": this.inline(title),
			"{{SITE_NAV}}": this.opts.siteNavHtml || "",
			"{{SUBTITLE}}": optional("subtitle", "p", "sub"),
			"{{NOTICE}}": optional("notice", "p", "notice"),
			"{{VERSION}}": this.opts.versionHtml || "",
			"{{TOC}}": toc,
			"{{CONTENT}}": content,
		};
		// One pass, so text in the note that looks like a placeholder is left alone.
		html = TEMPLATE.replace(/\{\{[A-Z_]+\}\}/g, (key) => fields[key] ?? key);
		return { html, title: plainTitle, warnings: this.warnings };
	}
}

function extname(name: string): string {
	const m = /\.[^./\\]+$/.exec(name);
	return m ? m[0].toLowerCase() : "";
}

function safeDecode(s: string): string {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}

export function render(opts: RenderOptions): RenderResult {
	return new Renderer(opts).render();
}
