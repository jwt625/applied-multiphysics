// SPDX-License-Identifier: GPL-3.0-or-later
// Display helpers: length unit chosen from the model size, categorical domain colours (UI only, no meaning).
export function lengthUnit(size: number): { unit: string; f: number } {
	if (size < 1e-4) return { unit: 'um', f: 1e6 };
	if (size < 0.2) return { unit: 'mm', f: 1e3 };
	if (size < 2) return { unit: 'cm', f: 1e2 };
	return { unit: 'm', f: 1 };
}

const PALETTE = ['#5b7fa6', '#8a6e9e', '#5f9a7f', '#a68b5b', '#9e6e6e', '#6e8f9e', '#7f8a5b', '#9e7f6e', '#6e6e9e', '#5b9a9a'];
export function domainColors(n: number): string[] {
	return Array.from({ length: n }, (_, i) => PALETTE[i % PALETTE.length]!);
}
