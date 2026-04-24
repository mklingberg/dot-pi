import type { ExtensionAPI, ToolCallEvent } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
function parseYamlValue(val: string): string | boolean | null {
	val = val.trim();
	if (val === "true") return true;
	if (val === "false") return false;
	if (val === "null" || val === "~") return null;
	if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
		return val.slice(1, -1);
	}
	return val;
}

function yamlParse(content: string): Record<string, unknown> {
	const lines = content.split("\n");
	const result: Record<string, unknown> = {};
	let currentKey: string | null = null;
	let currentList: unknown[] | null = null;
	let currentObj: Record<string, unknown> | null = null;

	for (const rawLine of lines) {
		const line = rawLine.trimEnd();
		if (!line.trim() || line.trim().startsWith("#")) continue;

		// Top-level key (e.g. "bashToolPatterns:")
		const topKeyMatch = line.match(/^(\w+):\s*$/);
		if (topKeyMatch) {
			currentKey = topKeyMatch[1];
			result[currentKey] = [];
			currentList = result[currentKey] as unknown[];
			currentObj = null;
			continue;
		}

		// List item starting an object (e.g. "  - pattern: '...'")
		const listObjMatch = line.match(/^  - (\w+):\s*(.*)$/);
		if (listObjMatch && currentList !== null) {
			currentObj = { [listObjMatch[1]]: parseYamlValue(listObjMatch[2]) };
			currentList.push(currentObj);
			continue;
		}

		// Plain list item (e.g. "  - somepath")
		const listStrMatch = line.match(/^  - (.+)$/);
		if (listStrMatch && currentList !== null) {
			currentList.push(parseYamlValue(listStrMatch[1]));
			currentObj = null;
			continue;
		}

		// Object property continuation (e.g. "    reason: '...'")
		const objPropMatch = line.match(/^    (\w+):\s*(.*)$/);
		if (objPropMatch && currentObj !== null) {
			currentObj[objPropMatch[1]] = parseYamlValue(objPropMatch[2]);
			continue;
		}
	}

	return result;
}
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
//import { applyExtensionDefaults } from "./themeMap.ts";

interface Rule {
	pattern: string;
	reason: string;
	ask?: boolean;
}

interface Rules {
	bashToolPatterns: Rule[];
	zeroAccessPaths: string[];
	readOnlyPaths: string[];
	noDeletePaths: string[];
}

interface CompiledRule extends Rule {
	regex: RegExp;
}

interface CompileResult {
	compiled: CompiledRule[];
	invalid: number;
}

export default function (pi: ExtensionAPI) {
	let rules: Rules = {
		bashToolPatterns: [],
		zeroAccessPaths: [],
		readOnlyPaths: [],
		noDeletePaths: [],
	};
	let compiledBashRules: CompiledRule[] = [];
	let invalidBashRuleCount = 0;

	function resolvePath(p: string, cwd: string): string {
		if (p.startsWith("~")) {
			p = path.join(os.homedir(), p.slice(1));
		}
		return path.resolve(cwd, p);
	}

	function isPathMatch(targetPath: string, pattern: string, cwd: string): boolean {
		// Simple glob-to-regex or substring match
		// Expand tilde in pattern if present
		const resolvedPattern = pattern.startsWith("~") ? path.join(os.homedir(), pattern.slice(1)) : pattern;

		// If pattern ends with /, it's a directory match
		if (resolvedPattern.endsWith("/")) {
			const absolutePattern = path.isAbsolute(resolvedPattern) ? resolvedPattern : path.resolve(cwd, resolvedPattern);
			return targetPath.startsWith(absolutePattern);
		}

		// Handle basic wildcards *
		const regexPattern = resolvedPattern
			.replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex chars
			.replace(/\*/g, ".*"); // convert * to .*

		const regex = new RegExp(`^${regexPattern}$|^${regexPattern}/|/${regexPattern}$|/${regexPattern}/`);

		// Match against absolute path and relative-to-cwd path
		const relativePath = path.relative(cwd, targetPath);

		return regex.test(targetPath) || regex.test(relativePath) || targetPath.includes(resolvedPattern) || relativePath.includes(resolvedPattern);
	}

	function tokenizeCommand(command: string): string[] {
		const rawTokens = command.match(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\S+/g) || [];
		return rawTokens
			.map((t) => t.trim())
			.map((t) => ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) ? t.slice(1, -1) : t))
			.filter(Boolean);
	}

	function extractPathLikeTokens(command: string): string[] {
		const shellOperators = new Set(["&&", "||", "|", ";", "(", ")", ">", ">>", "<", "<<"]);
		return tokenizeCommand(command).filter((token) => {
			if (shellOperators.has(token)) return false;
			if (/^\d?>/.test(token)) return false;
			if (token.startsWith("-")) return false;
			if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token)) return false;
			return true;
		});
	}

	function compileBashRules(ctx: { ui: { notify: (message: string) => void } }, list: Rule[]): CompileResult {
		const compiled: CompiledRule[] = [];
		let invalid = 0;
		for (const rule of list) {
			try {
				compiled.push({ ...rule, regex: new RegExp(rule.pattern) });
			} catch (err) {
				invalid++;
				ctx.ui.notify(`🛡️ Damage-Control: Invalid regex skipped (${rule.reason}): ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		if (invalid > 0) {
			ctx.ui.notify(`🛡️ Damage-Control: Skipped ${invalid} invalid regex rule(s).`);
		}
		return { compiled, invalid };
	}

	pi.on("session_start", async (_event, ctx) => {
		//applyExtensionDefaults(import.meta.url, ctx);
		const projectRulesPath = path.join(ctx.cwd, ".pi", "damage-control-rules.yaml");
		const globalRulesPath = path.join(os.homedir(), ".pi", "damage-control-rules.yaml");
		const rulesPath = fs.existsSync(projectRulesPath) ? projectRulesPath : fs.existsSync(globalRulesPath) ? globalRulesPath : null;
		try {
			if (rulesPath) {
				const content = fs.readFileSync(rulesPath, "utf8");
				const loaded = yamlParse(content) as Partial<Rules>;
				rules = {
					bashToolPatterns: loaded.bashToolPatterns || [],
					zeroAccessPaths: loaded.zeroAccessPaths || [],
					readOnlyPaths: loaded.readOnlyPaths || [],
					noDeletePaths: loaded.noDeletePaths || [],
				};
				const compileResult = compileBashRules(ctx, rules.bashToolPatterns);
				compiledBashRules = compileResult.compiled;
				invalidBashRuleCount = compileResult.invalid;
				const source = rulesPath === projectRulesPath ? "project" : "global";
				const configured = rules.bashToolPatterns.length + rules.zeroAccessPaths.length + rules.readOnlyPaths.length + rules.noDeletePaths.length;
				const active = compiledBashRules.length + rules.zeroAccessPaths.length + rules.readOnlyPaths.length + rules.noDeletePaths.length;
				const invalidSuffix = invalidBashRuleCount > 0 ? `, invalid regex: ${invalidBashRuleCount}` : "";
				ctx.ui.notify(`🛡️ Damage-Control: Loaded rules (${source}) — active: ${active}, configured: ${configured}${invalidSuffix}.`);
			} else {
				compiledBashRules = [];
				invalidBashRuleCount = 0;
				ctx.ui.notify("🛡️ Damage-Control: No rules found at .pi/damage-control-rules.yaml (project or global)");
			}
		} catch (err) {
			ctx.ui.notify(`🛡️ Damage-Control: Failed to load rules: ${err instanceof Error ? err.message : String(err)}`);
		}

		const activeRulesCount = compiledBashRules.length + rules.zeroAccessPaths.length + rules.readOnlyPaths.length + rules.noDeletePaths.length;
		const statusInvalidSuffix = invalidBashRuleCount > 0 ? ` (invalid regex: ${invalidBashRuleCount})` : "";
		ctx.ui.setStatus(`🛡️ Damage-Control Active: ${activeRulesCount} Rules${statusInvalidSuffix}`);
	});

	pi.on("tool_call", async (event, ctx) => {
		let violationReason: string | null = null;
		let shouldAsk = false;

		// 1. Check Zero Access Paths for all tools that use path or glob
		const checkPaths = (pathsToCheck: string[]) => {
			for (const p of pathsToCheck) {
				const resolved = resolvePath(p, ctx.cwd);
				for (const zap of rules.zeroAccessPaths) {
					if (isPathMatch(resolved, zap, ctx.cwd)) {
						return `Access to zero-access path restricted: ${zap}`;
					}
				}
			}
			return null;
		};

		// Extract paths from tool input
		const inputPaths: string[] = [];
		if (isToolCallEventType("read", event) || isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
			inputPaths.push(event.input.path);
		} else if (isToolCallEventType("grep", event) || isToolCallEventType("find", event) || isToolCallEventType("ls", event)) {
			inputPaths.push(event.input.path || ".");
		}

		if (isToolCallEventType("grep", event) && event.input.glob) {
			// Check glob field as well
			for (const zap of rules.zeroAccessPaths) {
				if (event.input.glob.includes(zap) || isPathMatch(event.input.glob, zap, ctx.cwd)) {
					violationReason = `Glob matches zero-access path: ${zap}`;
					break;
				}
			}
		}

		if (!violationReason) {
			violationReason = checkPaths(inputPaths);
		}

		// 2. Tool-specific logic
		if (!violationReason) {
			if (isToolCallEventType("bash", event)) {
				const command = event.input.command;

				// Check bashToolPatterns (precompiled during session_start)
				for (const rule of compiledBashRules) {
					if (rule.regex.test(command)) {
						violationReason = rule.reason;
						shouldAsk = !!rule.ask;
						break;
					}
				}

				// Check if bash command interacts with restricted paths
				if (!violationReason) {
					const pathTokens = extractPathLikeTokens(command);
					for (const zap of rules.zeroAccessPaths) {
						const expandedZap = zap.startsWith("~") ? path.join(os.homedir(), zap.slice(1)) : zap;
						if (command.includes(expandedZap) || command.includes(zap)) {
							violationReason = `Bash command references zero-access path: ${zap}`;
							break;
						}
						for (const token of pathTokens) {
							const resolvedToken = resolvePath(token, ctx.cwd);
							if (isPathMatch(resolvedToken, zap, ctx.cwd) || isPathMatch(token, zap, ctx.cwd)) {
								violationReason = `Bash command references zero-access path: ${zap}`;
								break;
							}
						}
						if (violationReason) break;
					}
				}

				if (!violationReason) {
					for (const rop of rules.readOnlyPaths) {
						// Heuristic: check if command might modify a read-only path
						// Redirects, sed -i, rm, mv, tee, truncate, chmod, chown
						if (command.includes(rop) && (command.includes(">") || command.includes("rm") || command.includes("mv") || command.includes("sed") || command.includes("tee") || command.includes("truncate") || command.includes("chmod") || command.includes("chown"))) {
							violationReason = `Bash command may modify read-only path: ${rop}`;
							break;
						}
					}
				}

				if (!violationReason) {
					for (const ndp of rules.noDeletePaths) {
						if (command.includes(ndp) && (command.includes("rm") || command.includes("mv"))) {
							violationReason = `Bash command attempts to delete/move protected path: ${ndp}`;
							break;
						}
					}
				}
			} else if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
				// Check Read-Only and No-Delete paths
				for (const p of inputPaths) {
					const resolved = resolvePath(p, ctx.cwd);
					for (const rop of rules.readOnlyPaths) {
						if (isPathMatch(resolved, rop, ctx.cwd)) {
							violationReason = `Modification of read-only path restricted: ${rop}`;
							break;
						}
					}
					if (violationReason) break;
					for (const ndp of rules.noDeletePaths) {
						if (isPathMatch(resolved, ndp, ctx.cwd)) {
							violationReason = `Modification of protected path restricted: ${ndp}`;
							break;
						}
					}
				}
			}
		}

		if (violationReason) {
			if (shouldAsk) {
				const previewContent = isToolCallEventType("bash", event)
					? `**⚠️ Rule triggered:** ${violationReason}\n\n\`\`\`bash\n${event.input.command}\n\`\`\``
					: `**⚠️ Rule triggered:** ${violationReason}\n\n\`\`\`json\n${JSON.stringify(event.input, null, 2)}\n\`\`\``;

				pi.sendMessage({ customType: "damage-control-preview", content: previewContent, display: true });

				const confirmed = await ctx.ui.confirm("🛡️ Damage-Control", "Allow this operation?\n(See preview above for details)", { timeout: 30000 });

				if (!confirmed) {
					ctx.ui.setStatus(`⚠️ Last Violation Blocked: ${violationReason.slice(0, 30)}...`);
					await pi.appendEntry("damage-control-log", { tool: event.toolName, input: event.input, rule: violationReason, action: "blocked_by_user" });
					ctx.abort();
					return { block: true, reason: `🛑 BLOCKED by Damage-Control: ${violationReason} (User denied)\n\nDO NOT attempt to work around this restriction. DO NOT retry with alternative commands, paths, or approaches that achieve the same result. Report this block to the user exactly as stated and ask how they would like to proceed.` };
				} else {
					await pi.appendEntry("damage-control-log", { tool: event.toolName, input: event.input, rule: violationReason, action: "confirmed_by_user" });
					return { block: false };
				}
			} else {
				ctx.ui.notify(`🛑 Damage-Control: Blocked ${event.toolName} due to ${violationReason}`);
				ctx.ui.setStatus(`⚠️ Last Violation: ${violationReason.slice(0, 30)}...`);
				pi.appendEntry("damage-control-log", { tool: event.toolName, input: event.input, rule: violationReason, action: "blocked" });
				ctx.abort();
				return { block: true, reason: `🛑 BLOCKED by Damage-Control: ${violationReason}\n\nDO NOT attempt to work around this restriction. DO NOT retry with alternative commands, paths, or approaches that achieve the same result. Report this block to the user exactly as stated and ask how they would like to proceed.` };
			}
		}

		return { block: false };
	});
}