// SPDX-License-Identifier: GPL-3.0-or-later
/** PNG of the graphics canvas (navigation tool `screenshot`); both renderers keep their drawing buffer. */
export function captureGraphics(root: ParentNode = document): { base64: string; width: number; height: number } | null {
	const c = root.querySelector('.gfx canvas') as HTMLCanvasElement | null;
	if (!c || !c.width) return null;
	try { return { base64: c.toDataURL('image/png').split(',')[1] ?? '', width: c.width, height: c.height }; } catch { return null; }
}
