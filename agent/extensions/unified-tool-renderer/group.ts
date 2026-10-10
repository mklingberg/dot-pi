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

export interface GroupTracker {
	onToolStart(id: string, toolName: string, args: any): void;
	onToolEnd(id: string, result: { isError?: boolean }): void;
	closeGroup(): void;
	lookup(id: string, toolName: string, args: any): { group: ToolGroup; isAnchor: boolean } | undefined;
	reset(): void;
}

export function createGroupTracker(options: GroupTrackerOptions = {}): GroupTracker {
	const exclude = new Set(options.exclude ?? DEFAULT_GROUP_EXCLUDE);
	const maxItems = options.maxItems ?? 256;
	const maxGroupItems = options.maxGroupItems ?? 64;

	let groups: ToolGroup[] = [];
	const byId = new Map<string, { group: ToolGroup; item: GroupItem }>();
	let liveGroup: ToolGroup | undefined;
	let renderGroup: ToolGroup | undefined;

	function evict(): void {
		while (byId.size > maxItems) {
			const idx = groups.findIndex((g) => g !== liveGroup && g !== renderGroup && g.items.every((i) => i.status !== "running"));
			if (idx < 0) return;
			const [g] = groups.splice(idx, 1);
			for (const i of g!.items) byId.delete(i.id);
		}
	}

	function add(group: ToolGroup, id: string, toolName: string, args: any, status: ItemStatus): void {
		const item: GroupItem = { id, toolName, args, status };
		group.items.push(item);
		byId.set(id, { group, item });
	}

	function newGroup(): ToolGroup {
		const g: ToolGroup = { items: [], expanded: false };
		groups.push(g);
		return g;
	}

	return {
		onToolStart(id, toolName, args) {
			if (exclude.has(toolName)) {
				liveGroup = undefined;
				return;
			}
			if (byId.has(id)) return;
			if (!liveGroup || liveGroup.items.length >= maxGroupItems) liveGroup = newGroup();
			add(liveGroup, id, toolName, args, "running");
			evict();
		},
		onToolEnd(id, result) {
			const entry = byId.get(id);
			if (entry) entry.item.status = result?.isError ? "error" : "done";
		},
		closeGroup() {
			liveGroup = undefined;
		},
		lookup(id, toolName, args) {
			if (exclude.has(toolName)) {
				renderGroup = undefined;
				return undefined;
			}
			let entry = byId.get(id);
			if (!entry) {
				if (!renderGroup || renderGroup.items.length >= maxGroupItems) renderGroup = newGroup();
				add(renderGroup, id, toolName, args, "done");
				evict();
				entry = byId.get(id)!;
			} else if (entry.group !== renderGroup) {
				renderGroup = undefined;
			}
			return { group: entry.group, isAnchor: entry.group.items[0]!.id === id };
		},
		reset() {
			groups = [];
			byId.clear();
			liveGroup = undefined;
			renderGroup = undefined;
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
