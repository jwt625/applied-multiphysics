// SPDX-License-Identifier: GPL-3.0-or-later
// Validation issues of a model in readable form (DevLog-015, audit S1): a parameter outside its range reads
// "D = 15 mm outside range 1-10 mm"; other issues keep their path and message.
import { unitLabel } from '../gfx/units';

type Issue = { dotted?: string; message: string };

export function friendlyIssues(issues: readonly Issue[], params: Record<string, { unit?: string }> | null | undefined): string[] {
	return issues.map((i) => {
		const m = /^params\.(\w+)\.value$/.exec(i.dotted ?? ''), r = /value (\S+) outside range \[([^,]+), ([^\]]+)\]/.exec(i.message);
		const u = m ? unitLabel(params?.[m[1]!]?.unit ?? '') : '';
		return m && r ? `${m[1]} = ${r[1]}${u ? ` ${u}` : ''} outside range ${r[2]}-${r[3]}${u ? ` ${u}` : ''}` : `${i.dotted || '(root)'}: ${i.message}`;
	});
}
