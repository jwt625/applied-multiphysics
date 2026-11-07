// SPDX-License-Identifier: GPL-3.0-or-later
// Wire validity of a request (audit B1). Messages API rules that a broken history violates, every one of which costs a
// 400 and, once in history, breaks every later request of the conversation:
//   - the first and the last message are user messages (a trailing assistant message is a prefill: 400 on Opus 5.5)
//   - no message has empty content; no text block is empty
//   - every tool_use of an assistant message is answered by a tool_result in the immediately following user message
//   - every tool_result answers a tool_use of the immediately preceding assistant message; tool_use ids are unique
// Assistant messages are checked as they will be sent: the provider's raw content when present.

import type { Message, ProviderRequest } from './types.ts';

type Blk = { type: string; id?: unknown; tool_use_id?: unknown; text?: unknown };

function blocksOf(m: Message): Blk[] {
  if (m.role === 'assistant' && m.raw) return m.raw.content as Blk[];
  return m.content as unknown as Blk[];
}

export function wireProblems(req: Pick<ProviderRequest, 'messages'>): string[] {
  const out: string[] = [];
  const ms = req.messages;
  if (!ms.length) return ['no messages'];
  if (ms[0]!.role !== 'user') out.push('first message is not a user message');
  if (ms.at(-1)!.role !== 'user') out.push('last message is not a user message (assistant prefill)');
  const seen = new Set<string>();
  ms.forEach((m, i) => {
    const bs = blocksOf(m);
    if (!bs.length) out.push(`message ${i} (${m.role}) has empty content`);
    for (const b of bs) if (b.type === 'text' && (typeof b.text !== 'string' || b.text.length === 0)) out.push(`message ${i}: empty text block`);
    if (m.role === 'assistant') {
      const uses = bs.filter((b) => b.type === 'tool_use').map((b) => String(b.id));
      for (const id of uses) { if (seen.has(id)) out.push(`message ${i}: duplicate tool_use id`); seen.add(id); }
      if (uses.length) {
        const next = ms[i + 1];
        const answered = new Set(next && next.role === 'user' ? blocksOf(next).filter((b) => b.type === 'tool_result').map((b) => String(b.tool_use_id)) : []);
        for (const id of uses) if (!answered.has(id)) out.push(`message ${i}: tool_use ${id} has no tool_result in the next user message`);
      }
    } else {
      const results = bs.filter((b) => b.type === 'tool_result').map((b) => String(b.tool_use_id));
      if (results.length) {
        const prev = ms[i - 1];
        const asked = new Set(prev && prev.role === 'assistant' ? blocksOf(prev).filter((b) => b.type === 'tool_use').map((b) => String(b.id)) : []);
        for (const id of results) if (!asked.has(id)) out.push(`message ${i}: tool_result ${id} answers no tool_use of the previous assistant message`);
      }
    }
  });
  return out;
}
