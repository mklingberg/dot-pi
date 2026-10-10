/**
 * Planning panel — shows create-plans progress from `.planning/` above the editor.
 *
 * Progress is derived from files, never stored (same rule as the create-plans skill):
 * - a plan is done when its NN-MM-SUMMARY.md exists
 * - a phase is done when every PLAN.md in it has a SUMMARY
 * - the current phase is the first not-done phase (no PLANs yet = not done);
 *   phases under ROADMAP's `## Deferred` are skipped
 *
 * /plan            cycle full → compact → hidden
 * /plan full|compact|hidden|refresh
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

type Mode = "full" | "compact" | "hidden";

interface Plan {
	id: string; // "03-01"
	done: boolean;
	tasks: number;
	title: string;
}

interface Phase {
	num: number;
	key: string; // "03"
	name: string;
	plans: Plan[];
	expected: number; // plan bullets in ROADMAP, 0 if unknown
	deferred: boolean;
	hasDir: boolean;
	superseded: boolean; // phase dir has SUPERSEDED.md notes
}

interface Snapshot {
	title: string;
	phases: Phase[];
	openIssues: number;
}

const WIDGET_KEY = "planning-panel";
const MODES: Mode[] = ["full", "compact", "hidden"];

function findPlanningDir(cwd: string): string | undefined {
	const stop = path.dirname(os.homedir());
	let dir = path.resolve(cwd);
	while (true) {
		const candidate = path.join(dir, ".planning");
		try {
			if (fs.statSync(candidate).isDirectory()) return candidate;
		} catch {}
		const parent = path.dirname(dir);
		if (parent === dir || parent === stop) return undefined;
		dir = parent;
	}
}

function findProjectRoot(cwd: string): string {
	const stop = path.dirname(os.homedir());
	let dir = path.resolve(cwd);
	while (true) {
		if (fs.existsSync(path.join(dir, ".git"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir || parent === stop) return path.resolve(cwd);
		dir = parent;
	}
}

function readText(file: string): string | undefined {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

function parseRoadmap(text: string | undefined): Map<number, { name: string; expected: number; deferred: boolean }> {
	const out = new Map<number, { name: string; expected: number; deferred: boolean }>();
	if (!text) return out;
	let inDeferred = false;
	let current: number | undefined;
	for (const line of text.split(/\r?\n/)) {
		const h2 = line.match(/^##\s+(.+)$/);
		if (h2) {
			inDeferred = /deferred/i.test(h2[1]);
			current = undefined;
		}
		// "### Phase 3: Name" or "- **Phase 3: Name** - desc"
		const ph = line.match(/^(?:###\s+|\s*[-*]\s+\*\*)Phase\s+(\d+)\s*[:.-]\s*([^*]+?)(?:\*\*.*)?$/i);
		if (ph) {
			const num = Number(ph[1]);
			const prev = out.get(num);
			out.set(num, {
				name: ph[2].trim(),
				expected: prev?.expected ?? 0,
				deferred: (prev?.deferred ?? false) || inDeferred,
			});
			current = line.startsWith("###") ? num : undefined;
			continue;
		}
		const bullet = line.match(/^\s*[-*]\s+(\d+)-(\d+)\s*:/);
		if (bullet && current !== undefined && Number(bullet[1]) === current) {
			const entry = out.get(current)!;
			entry.expected++;
		}
	}
	return out;
}

function planTitle(text: string): string {
	const objective = text.match(/<objective>\s*([\s\S]*?)<\/objective>/i)?.[1] ?? "";
	const firstPara = objective.split(/\n\s*\n/)[0] ?? "";
	const flat = firstPara.replace(/\s+/g, " ").trim();
	const sentence = flat.match(/^(.+?[.:;])(\s|$)/)?.[1] ?? flat;
	return sentence.replace(/[.:;]$/, "");
}

function countOpenIssues(text: string | undefined): number {
	if (!text) return 0;
	const open = text.split(/^##\s+Closed\b.*$/im)[0] ?? "";
	return (open.match(/^#{2,3}\s+ISS-\d+/gim) ?? []).length;
}

function readSnapshot(planningDir: string): Snapshot {
	const roadmap = parseRoadmap(readText(path.join(planningDir, "ROADMAP.md")));
	const brief = readText(path.join(planningDir, "BRIEF.md"));
	const title =
		brief?.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? path.basename(path.dirname(planningDir));

	const phases = new Map<number, Phase>();
	const phasesDir = path.join(planningDir, "phases");
	let dirs: string[] = [];
	try {
		dirs = fs.readdirSync(phasesDir);
	} catch {}

	for (const dirName of dirs) {
		const m = dirName.match(/^(\d+)-(.+)$/);
		if (!m) continue;
		const full = path.join(phasesDir, dirName);
		let files: string[];
		try {
			if (!fs.statSync(full).isDirectory()) continue;
			files = fs.readdirSync(full);
		} catch {
			continue;
		}
		const num = Number(m[1]);
		const fileSet = new Set(files);
		const plans: Plan[] = files
			.map((f) => f.match(/^(\d+-\d+)-PLAN\.md$/))
			.filter((x): x is RegExpMatchArray => !!x)
			.map((x) => {
				const id = x[1];
				const text = readText(path.join(full, x[0])) ?? "";
				return {
					id,
					done: fileSet.has(`${id}-SUMMARY.md`),
					tasks: (text.match(/<task\b/g) ?? []).length,
					title: planTitle(text),
				};
			})
			.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
		const rm = roadmap.get(num);
		phases.set(num, {
			num,
			key: m[1],
			name: rm?.name ?? m[2],
			plans,
			expected: rm?.expected ?? 0,
			deferred: rm?.deferred ?? false,
			hasDir: true,
			superseded: fileSet.has("SUPERSEDED.md"),
		});
	}

	for (const [num, rm] of roadmap) {
		if (phases.has(num)) continue;
		phases.set(num, {
			num,
			key: String(num).padStart(2, "0"),
			name: rm.name,
			plans: [],
			expected: rm.expected,
			deferred: rm.deferred,
			hasDir: false,
			superseded: false,
		});
	}

	return {
		title,
		phases: [...phases.values()].sort((a, b) => a.num - b.num),
		openIssues: countOpenIssues(readText(path.join(planningDir, "ISSUES.md"))),
	};
}

const phaseDone = (p: Phase) => p.plans.length > 0 && p.plans.every((x) => x.done);
const doneCount = (p: Phase) => p.plans.filter((x) => x.done).length;
const totalCount = (p: Phase) => Math.max(p.plans.length, p.expected);

function currentPhase(s: Snapshot): Phase | undefined {
	return s.phases.find((p) => !p.deferred && !phaseDone(p));
}

const MAX_PENDING_PLANS = 5;

/** Layout mirrors pi-subagents' "● Agents" widget: heading, dim tree connectors,
 *  status icon + bold name for the active row, dim " · " stats, "⎿" detail lines. */
function render(s: Snapshot, mode: Mode, theme: any, width: number): string[] {
	const fg = (color: string, text: string) => theme.fg(color, text);
	const sep = fg("dim", " · ");
	const active = s.phases.filter((p) => !p.deferred);
	const plansDone = active.reduce((n, p) => n + doneCount(p), 0);
	const plansTotal = active.reduce((n, p) => n + totalCount(p), 0);
	const cur = currentPhase(s);
	const headingColor = cur ? "accent" : "dim";

	const stats = [`${plansDone}/${plansTotal} plans`];
	if (s.openIssues > 0) stats.push(fg("warning", `${s.openIssues} open issue${s.openIssues === 1 ? "" : "s"}`));
	if (!cur && active.length > 0) stats.push(fg("success", "all done"));
	if (mode === "compact" && cur) stats.push(`now ${cur.key} ${cur.name} ${doneCount(cur)}/${totalCount(cur)}`);

	const heading =
		fg(headingColor, cur ? "●" : "○") + " " + fg(headingColor, "Plan") + "  " +
		fg("muted", s.title) + sep + fg("dim", stats.join(fg("dim", " · ")));
	if (mode === "compact") return [truncateToWidth(heading, width)];

	// Each phase = one row plus optional detail lines (current phase only).
	const rows: { head: string; details: string[] }[] = s.phases.map((p) => {
		const d = doneCount(p);
		const t = totalCount(p);
		const isCur = p === cur;
		const done = phaseDone(p);
		let icon: string;
		if (p.deferred) icon = fg("dim", "⊘");
		else if (done) icon = fg("success", "✓");
		else if (isCur) icon = fg("accent", d > 0 ? "◐" : "○");
		else if (t === 0) icon = fg("muted", "◦");
		else icon = fg("muted", d > 0 ? "◐" : "○");

		const label = `${p.key} ${p.name}`;
		const name = isCur ? theme.bold(label) : done || p.deferred ? fg("dim", label) : fg("muted", label);
		const info = p.deferred ? "deferred" : t === 0 ? "not planned" : `${d}/${t}`;
		const extra = p.superseded ? sep + fg("dim", "superseded notes") : "";
		const head = `${icon} ${name}${sep}${fg("dim", info)}${extra}`;

		const details: string[] = [];
		if (isCur && p.plans.length > 0) {
			const pending = p.plans.filter((x) => !x.done);
			const doneN = p.plans.length - pending.length;
			if (doneN > 0) details.push(fg("success", "✓") + " " + fg("dim", `${doneN} done`));
			for (const plan of pending.slice(0, MAX_PENDING_PLANS)) {
				const tasks = plan.tasks > 0 ? sep + fg("dim", `${plan.tasks} task${plan.tasks === 1 ? "" : "s"}`) : "";
				const title = plan.title ? " " + fg("muted", plan.title) : "";
				details.push(fg("muted", "○") + " " + fg("text", plan.id) + title + tasks);
			}
			if (pending.length > MAX_PENDING_PLANS) details.push(fg("dim", `+${pending.length - MAX_PENDING_PLANS} more`));
		}
		return { head, details };
	});

	const lines = [heading];
	rows.forEach((row, i) => {
		const last = i === rows.length - 1;
		lines.push(fg("dim", last ? "└─" : "├─") + " " + row.head);
		row.details.forEach((detail, j) => {
			const stem = fg("dim", last ? "   " : "│  ");
			const hook = fg("dim", j === 0 ? "  ⎿  " : "     ");
			lines.push(stem + hook + detail);
		});
	});
	return lines.map((l) => truncateToWidth(l, width));
}

export default function planningPanel(pi: ExtensionAPI) {
	let mode: Mode = "full";
	let planningDir: string | undefined;
	let snapshot: Snapshot | undefined;
	let watcher: fs.FSWatcher | undefined;
	let debounce: NodeJS.Timeout | undefined;
	let requestRender: (() => void) | undefined;
	let lastCtx: ExtensionContext | undefined;

	const stopWatching = () => {
		watcher?.close();
		watcher = undefined;
		if (debounce) clearTimeout(debounce);
		debounce = undefined;
	};

	const refresh = () => {
		if (!planningDir) return;
		try {
			snapshot = readSnapshot(planningDir);
		} catch {
			snapshot = undefined;
		}
		requestRender?.();
	};

	const mount = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (!planningDir || mode === "hidden") {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			requestRender = undefined;
			return;
		}
		ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
			requestRender = () => tui.requestRender();
			return {
				render: (width: number) => (snapshot ? render(snapshot, mode, theme, width) : []),
				invalidate: () => {},
				dispose: () => {
					requestRender = undefined;
				},
			};
		});
	};

	const schedule = (fn: () => void) => {
		if (debounce) clearTimeout(debounce);
		debounce = setTimeout(fn, 250);
	};

	const start = (ctx: ExtensionContext) => {
		lastCtx = ctx;
		stopWatching();
		planningDir = findPlanningDir(ctx.cwd);
		if (planningDir) {
			const dir = planningDir;
			refresh();
			// Re-read on any change; if .planning/ itself is removed, fall back to waiting for it.
			try {
				watcher = fs.watch(dir, { recursive: true }, () =>
					schedule(() => (fs.existsSync(dir) ? refresh() : start(ctx))),
				);
				watcher.on("error", () => schedule(() => start(ctx)));
			} catch {}
		} else {
			snapshot = undefined;
			// .planning/ is created mid-session by the agent: watch the project root for it.
			const root = findProjectRoot(ctx.cwd);
			try {
				watcher = fs.watch(root, (_event, filename) => {
					if (filename && String(filename) !== ".planning") return;
					schedule(() => {
						if (findPlanningDir(ctx.cwd)) start(ctx);
					});
				});
				watcher.on("error", () => {});
			} catch {}
		}
		mount(ctx);
	};

	pi.on("session_start", (_event, ctx) => start(ctx));
	pi.on("session_shutdown", () => {
		stopWatching();
		lastCtx?.hasUI && lastCtx.ui.setWidget(WIDGET_KEY, undefined);
	});

	pi.registerCommand("plan", {
		description: "Planning panel: cycle full/compact/hidden, or /plan full|compact|hidden|refresh",
		getArgumentCompletions: (prefix) =>
			[...MODES, "refresh"].filter((m) => m.startsWith(prefix)).map((m) => ({ value: m, label: m })),
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "refresh") {
				start(ctx);
				if (!planningDir) ctx.ui.notify("No .planning/ found from this directory", "info");
				return;
			}
			if ((MODES as string[]).includes(arg)) mode = arg as Mode;
			else mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
			if (!planningDir) start(ctx);
			if (!planningDir) {
				ctx.ui.notify("No .planning/ found from this directory", "info");
				return;
			}
			mount(ctx);
			ctx.ui.notify(`Planning panel: ${mode}`, "info");
		},
	});
}
