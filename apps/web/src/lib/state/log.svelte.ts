// SPDX-License-Identifier: GPL-3.0-or-later
// Messages / Log / Progress stores. Every log row starts with its ISO timestamp (s.6).
import { nowIso } from '../engine/protocol';

export type Level = 'info' | 'warn' | 'error';
export interface LogRow { ts: string; level: Level; msg: string }
export interface ProgressRow { ts: string; stage: string; frac: number; msg?: string; run: string }

class AppLog {
	rows = $state<LogRow[]>([]);
	progress = $state<ProgressRow[]>([]);

	add(level: Level, msg: string): void {
		this.rows.push({ ts: nowIso(), level, msg });
		if (this.rows.length > 2000) this.rows.splice(0, this.rows.length - 2000);
	}
	info(msg: string) { this.add('info', msg); }
	warn(msg: string) { this.add('warn', msg); }
	error(msg: string) { this.add('error', msg); }

	stage(run: string, stage: string, frac: number, msg: string | undefined, ts: string): void {
		const i = this.progress.findIndex((p) => p.run === run && p.stage === stage);
		const row: ProgressRow = { ts, stage, frac, run, ...(msg ? { msg } : {}) };
		if (i >= 0) this.progress[i] = row;
		else this.progress.push(row);
		if (this.progress.length > 200) this.progress.splice(0, this.progress.length - 200);
	}
	clearProgress() { this.progress = []; }
}

export const appLog = new AppLog();

/** Time part of an ISO timestamp for dense rows (the full stamp goes in the tooltip). */
export const tsShort = (ts: string): string => ts.slice(11, 23);
