/* `/laser{488}` inside Obsidian: reading view, live preview and autocomplete. */
import {
	App, Editor, EditorPosition, EditorSuggest, EditorSuggestContext, EditorSuggestTriggerInfo,
	MarkdownPostProcessor, editorLivePreviewField,
} from "obsidian";
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { COMMON_LINES, LASER, laserEl } from "./laser";

/** Reading view: swap the text for chips, leaving code alone. */
export const laserPostProcessor: MarkdownPostProcessor = (el) => {
	const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
		acceptNode: (node) =>
			node.parentElement?.closest("code, pre, .laser") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
	});
	const hits: Text[] = [];
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		if (/\/laser\{\d{3,4}\}/.test(n.nodeValue || "")) hits.push(n as Text);
	}
	for (const node of hits) {
		const text = node.nodeValue || "";
		const frag = document.createDocumentFragment();
		let last = 0;
		for (const m of text.matchAll(LASER)) {
			frag.append(text.slice(last, m.index), laserEl(Number(m[1])));
			last = (m.index || 0) + m[0].length;
		}
		frag.append(text.slice(last));
		node.replaceWith(frag);
	}
};

class LaserWidget extends WidgetType {
	constructor(private nm: number) {
		super();
	}
	eq(other: LaserWidget) {
		return other.nm === this.nm;
	}
	toDOM() {
		return laserEl(this.nm);
	}
}

/**
 * Live preview: show the chip, except while the cursor is on it (so it can be
 * edited) or inside code.
 */
export const laserLivePreview = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;
		constructor(view: EditorView) {
			this.decorations = this.build(view);
		}
		update(u: ViewUpdate) {
			if (u.docChanged || u.viewportChanged || u.selectionSet ||
				u.startState.field(editorLivePreviewField) !== u.state.field(editorLivePreviewField)) {
				this.decorations = this.build(u.view);
			}
		}
		build(view: EditorView): DecorationSet {
			const builder = new RangeSetBuilder<Decoration>();
			if (!view.state.field(editorLivePreviewField)) return builder.finish();
			const tree = syntaxTree(view.state);
			const sel = view.state.selection;
			for (const { from, to } of view.visibleRanges) {
				const text = view.state.sliceDoc(from, to);
				for (const m of text.matchAll(LASER)) {
					const start = from + (m.index || 0);
					const end = start + m[0].length;
					if (sel.ranges.some((r) => r.from <= end && r.to >= start)) continue;
					const node = tree.resolveInner(start + 1, 1);
					if (/code|math/i.test(node.type.name)) continue;
					builder.add(start, end, Decoration.replace({ widget: new LaserWidget(Number(m[1])) }));
				}
			}
			return builder.finish();
		}
	},
	{ decorations: (v) => v.decorations },
);

/** Typing `/laser` offers the common lines. */
export class LaserSuggest extends EditorSuggest<[number, string]> {
	constructor(app: App) {
		super(app);
	}

	onTrigger(cursor: EditorPosition, editor: Editor): EditorSuggestTriggerInfo | null {
		const before = editor.getLine(cursor.line).slice(0, cursor.ch);
		const m = /(?:^|[\s(|])(\/laser(?:\{(\d*))?)$/.exec(before);
		if (!m) return null;
		return {
			start: { line: cursor.line, ch: cursor.ch - m[1].length },
			end: cursor,
			query: m[2] || "",
		};
	}

	getSuggestions(ctx: EditorSuggestContext): [number, string][] {
		const q = ctx.query;
		const hits = COMMON_LINES.filter(([nm]) => String(nm).startsWith(q));
		// A wavelength that isn't in the list can still be typed in full.
		if (/^\d{3,4}$/.test(q) && !hits.some(([nm]) => String(nm) === q)) hits.unshift([Number(q), "custom line"]);
		return hits;
	}

	renderSuggestion([nm, note]: [number, string], el: HTMLElement) {
		el.addClass("laser-suggestion");
		el.appendChild(laserEl(nm));
		el.createSpan({ text: note, cls: "laser-suggestion-note" });
	}

	selectSuggestion([nm]: [number, string]) {
		const ctx = this.context;
		if (!ctx) return;
		const line = ctx.editor.getLine(ctx.end.line);
		// Swallow a closing brace that's already there.
		const end = line.charAt(ctx.end.ch) === "}" ? { ...ctx.end, ch: ctx.end.ch + 1 } : ctx.end;
		ctx.editor.replaceRange(`/laser{${nm}}`, ctx.start, end);
		ctx.editor.setCursor({ line: ctx.start.line, ch: ctx.start.ch + `/laser{${nm}}`.length });
	}
}
