// SPDX-License-Identifier: GPL-3.0-or-later
// Screenshot of the graphics canvas on demand (navigation tool `screenshot`). The renderers do not keep their drawing
// buffer (audit M11); a registered canvas redraws and reads back in the same task.
type Grab = () => { base64: string; width: number; height: number } | null;
const grabs = new Set<Grab>();

export function registerCapture(g: Grab): () => void {
	grabs.add(g);
	return () => grabs.delete(g);
}

export function captureGraphics(): { base64: string; width: number; height: number } | null {
	for (const g of grabs) {
		const r = g();
		if (r) return r;
	}
	return null;
}

export function grabCanvas(c: HTMLCanvasElement, redraw: () => void): { base64: string; width: number; height: number } | null {
	try {
		redraw();
		return { base64: c.toDataURL('image/png').split(',')[1] ?? '', width: c.width, height: c.height };
	} catch {
		return null;
	}
}
