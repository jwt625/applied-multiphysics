// SPDX-License-Identifier: GPL-3.0-or-later
// The mounted chat controller, shared by the Agent panel and the Memory tab.
import type { ChatController } from '@amp/agent';

class AgentStore {
	chat = $state.raw<ChatController | null>(null);
	/** bumped after every chat event so memory views re-read the store */
	tick = $state(0);
}
export const agentStore = new AgentStore();
