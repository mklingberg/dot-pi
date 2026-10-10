/**
 * Pure grouping core for the unified tool renderer: tracks runs of consecutive
 * non-mutation tool calls and produces a Claude Code style summary line.
 * No Pi / pi-tui imports — keep render code elsewhere.
 */

export const DEFAULT_GROUP_EXCLUDE: string[] = ["edit", "write", "Agent", "SubagentWorkflow", "ask_user_question"];

export type ItemStatus = "running" | "done" | "error";

export interface GroupItem {
	id: string;
	toolName: string;
	args: any;
	status: ItemStatus;
}

export interface ToolGroup {
	items: GroupItem[];
	expanded: boolean;
}

export interface GroupTrackerOptions {
	exclude?: string[];
	maxItems?: number;
	maxGroupItems?: number;
}

export interface ContentBlock {
	type: string;
	[key: string]: any;
}

export interface GroupTracker {
	/** Walk an assistant message's content (idempotent for growing/streamed re-walks). */
	onAssistantContent(content: ContentBlock[], initialStatus?: ItemStatus): void;
	/** Optional hint that a new assistant message begins (resets per-message progress). */
	onAssistantStart(): void;
	onUserMessage(): void;
	onToolStart(id: string, toolName: string, args?: any): void;
	onToolEnd(id: string, result: { isError?: boolean }): void;
	closeGroup(): void;
	/** Read-only: group membership of an already-assigned id. */
	lookup(id: string): { group: ToolGroup; isAnchor: boolean } | undefined;
	reset(): void;
}

export function createGroupTracker(options: GroupTrackerOptions = {}): GroupTracker {
	const exclude = new Set(options.exclude ?? DEFAULT_GROUP_EXCLUDE);
	const maxItems = options.maxItems ?? 256;
	const maxGroupItems = options.maxGroupItems ?? 64;
	const MAX_PENDING = 512;

	let groups: ToolGroup[] = [];
	const byId = new Map<string, { group: ToolGroup; item: GroupItem }>();
	let liveGroup: ToolGroup | undefined;
	// Statuses reported before the id was assigned to a group.
	const pending = new Map<string, ItemStatus>();
	// Per-message walk progress.
	let callAt = new Map<number, string>();
	let textSeen = new Set<number>();
	let maxIndex = -1;

	function evict(): void {
		while (byId.size > maxItems) {
			const idx = groups.findIndex((g) => g !== liveGroup && g.items.every((i) => i.status !== "running"));
			if (idx < 0) return;
			const [g] = groups.splice(idx, 1);
			for (const i of g!.items) byId.delete(i.id);
		}
	}

	function newGroup(): ToolGroup {
		const g: ToolGroup = { items: [], expanded: false };
		groups.push(g);
		return g;
	}

	function resetMessage(): void {
		callAt = new Map();
		textSeen = new Set();
		maxIndex = -1;
	}

	function setStatus(id: string, status: ItemStatus): void {
		const entry = byId.get(id);
		if (entry) {
			entry.item.status = status;
			return;
		}
		pending.delete(id);
		pending.set(id, status);
		while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value!);
	}

	return {
		onAssistantStart() {
			resetMessage();
		},
		onUserMessage() {
			liveGroup = undefined;
			resetMessage();
		},
		onAssistantContent(content, initialStatus = "running") {
			if (!Array.isArray(content)) return;
			// A different message than the one we were walking → start fresh.
			let isNew = content.length - 1 < maxIndex;
			for (const [i, id] of callAt) {
				const b = content[i];
				if (!b || b.type !== "toolCall" || String(b.id) !== id) isNew = true;
			}
			if (isNew) resetMessage();
			content.forEach((block, i) => {
				if (!block) return;
				if (block.type === "text") {
					if (String(block.text ?? "").trim() && !textSeen.has(i)) {
						textSeen.add(i);
						liveGroup = undefined;
					}
					maxIndex = Math.max(maxIndex, i);
					return;
				}
				if (block.type !== "toolCall" || block.id == null) {
					maxIndex = Math.max(maxIndex, i);
					return;
				}
				const id = String(block.id);
				const name = String(block.name ?? "");
				maxIndex = Math.max(maxIndex, i);
				if (callAt.has(i)) {
					const entry = byId.get(id);
					if (entry && block.arguments !== undefined) entry.item.args = block.arguments;
					return;
				}
				if (!name) return; // name not streamed yet; decide on a later walk
				callAt.set(i, id);
				if (exclude.has(name)) {
					liveGroup = undefined;
					return;
				}
				if (byId.has(id)) return;
				if (!liveGroup || liveGroup.items.length >= maxGroupItems) liveGroup = newGroup();
				const item: GroupItem = { id, toolName: name, args: block.arguments ?? {}, status: pending.get(id) ?? initialStatus };
				pending.delete(id);
				liveGroup.items.push(item);
				byId.set(id, { group: liveGroup, item });
				evict();
			});
		},
		onToolStart(id, toolName, args) {
			setStatus(id, "running");
			const entry = byId.get(id);
			if (entry && args !== undefined) entry.item.args = args;
		},
		onToolEnd(id, result) {
			setStatus(id, result?.isError ? "error" : "done");
		},
		closeGroup() {
			liveGroup = undefined;
		},
		lookup(id) {
			const entry = byId.get(id);
			if (!entry) return undefined;
			return { group: entry.group, isAnchor: entry.group.items[0]!.id === id };
		},
		reset() {
			groups = [];
			byId.clear();
			pending.clear();
			liveGroup = undefined;
			resetMessage();
		},
	};
}

type Kind = "read" | "search" | "list" | "bash" | "batch" | "mcp" | "other";

const PHRASES: Record<Kind, { past: [string, string]; ing: [string, string] }> = {
	read: { past: ["read", "file"], ing: ["reading", "file"] },
	search: { past: ["searched", "pattern"], ing: ["searching", "pattern"] },
	list: { past: ["listed", "path"], ing: ["listing", "path"] },
	bash: { past: ["ran", "command"], ing: ["running", "command"] },
	batch: { past: ["ran", "batched call"], ing: ["running", "batched call"] },
	mcp: { past: ["called", "MCP tool"], ing: ["calling", "MCP tool"] },
	other: { past: ["used", "tool"], ing: ["using", "tool"] },
};

function kindOf(name: string): Kind {
	switch (name) {
		case "read": return "read";
		case "grep": return "search";
		case "find":
		case "ls": return "list";
		case "bash": return "bash";
		case "tool_batch": return "batch";
	}
	const lower = name.toLowerCase();
	if (lower.includes("mcp") || name.includes("__")) return "mcp";
	return "other";
}

export function summarize(items: GroupItem[]): string {
	const counts = new Map<Kind, number>();
	for (const item of items) {
		const kind = kindOf(item.toolName);
		const n = kind === "batch" && Array.isArray(item.args?.calls) ? item.args.calls.length : 1;
		counts.set(kind, (counts.get(kind) ?? 0) + n);
	}
	const running = items.some((i) => i.status === "running");
	const failed = items.filter((i) => i.status === "error").length;
	const parts = [...counts].map(([kind, n]) => {
		const p = PHRASES[kind];
		const [verb, noun] = running ? p.ing : p.past;
		return `${verb} ${n} ${noun}${n === 1 ? "" : "s"}`;
	});
	let text = parts.join(", ");
	text = text.charAt(0).toUpperCase() + text.slice(1);
	if (running) text += "…";
	if (failed > 0) text += ` (${failed} failed)`;
	return text;
}
