/*
 * `/laser{488}` → a dot in the colour of the channel that line excites, then
 * "488 nm". The four common lines keep fixed colours; anything in between is
 * blended from its neighbours, so every wavelength gets a sensible dot.
 */

export const LASER = /\/laser\{(\d{3,4})\}/g;

/** Lines offered by autocomplete, with the channel each one usually excites. */
export const COMMON_LINES: [number, string][] = [
	[405, "blue: DAPI, Hoechst"],
	[445, "cyan: CFP"],
	[488, "green: GFP, Alexa 488"],
	[514, "yellow: YFP"],
	[561, "orange: mCherry, Alexa 568"],
	[594, "red: Alexa 594"],
	[640, "far red: Alexa 647, Cy5"],
	[647, "far red: Alexa 647, Cy5"],
	[730, "near infrared: Alexa 750"],
];

const ANCHORS: [number, [number, number, number]][] = [
	[350, [0x6a, 0x3f, 0xc4]],
	[405, [0x2f, 0x57, 0xc4]],
	[488, [0x12, 0x7a, 0x3d]],
	[561, [0xb0, 0x60, 0x12]],
	[647, [0x9c, 0x2a, 0x85]],
	[800, [0x6b, 0x1f, 0x4f]],
];

export function laserColour(nm: number): string {
	const clamp = Math.min(Math.max(nm, ANCHORS[0][0]), ANCHORS[ANCHORS.length - 1][0]);
	let i = 0;
	while (i < ANCHORS.length - 2 && clamp > ANCHORS[i + 1][0]) i++;
	const [a, ca] = ANCHORS[i];
	const [b, cb] = ANCHORS[i + 1];
	const t = (clamp - a) / (b - a);
	return "#" + ca.map((v, k) => Math.round(v + (cb[k] - v) * t).toString(16).padStart(2, "0")).join("");
}

export function laserHtml(nm: number): string {
	return `<span class="laser" style="--laser:${laserColour(nm)}"><span class="laser-dot" aria-hidden="true"></span>${nm} nm</span>`;
}

/** The same chip as a DOM element, for Obsidian's own views. */
export function laserEl(nm: number): HTMLElement {
	const el = createSpan({ cls: "laser" });
	el.style.setProperty("--laser", laserColour(nm));
	el.createSpan({ cls: "laser-dot", attr: { "aria-hidden": "true" } });
	el.appendText(`${nm} nm`);
	return el;
}
