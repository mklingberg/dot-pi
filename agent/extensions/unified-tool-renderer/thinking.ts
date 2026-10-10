/**
 * Collapse consecutive hidden-thinking labels ("Thinking...") in Pi's chat log to one per run.
 * `dedupeThinkingRuns` is pure (no Pi imports) so it runs under `node --test`.
 */

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

const strip = (s: string): string => s.replace(ANSI_RE, "");
const oscOf = (s: string): string => (s.match(OSC_RE) ?? []).join("");

export interface DedupeChild {
	lines: string[];
	/** Set ⇒ child is an assistant message whose label lines may be dropped. */
	label?: string;
}

export function dedupeThinkingRuns(children: DedupeChild[]): string[][] {
	let inRun = false;
	return children.map((child) => {
		if (child.label === undefined) {
			if (child.lines.some((l) => strip(l).trim() !== "")) inRun = false;
			return [...child.lines];
		}
		const target = child.label.trim();
		const out: string[] = [];
		let buffer: string[] = [];
		let pendingOsc = "";
		const emit = (line: string) => {
			out.push(pendingOsc + line);
			pendingOsc = "";
		};
		const flush = () => {
			for (const b of buffer) emit(b);
			buffer = [];
		};
		for (const line of child.lines) {
			const text = strip(line).trim();
			if (text === "") {
				buffer.push(line);
			} else if (text === target) {
				if (inRun) {
					for (const b of buffer) pendingOsc += oscOf(b);
					pendingOsc += oscOf(line);
					buffer = [];
				} else {
					flush();
					emit(line);
					inRun = true;
				}
			} else {
				flush();
				emit(line);
				inRun = false;
			}
		}
		flush();
		if (pendingOsc && out.length > 0) out[out.length - 1] += pendingOsc;
		return out;
	});
}
