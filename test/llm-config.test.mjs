/**
 * llm-config tests: defaults (autoRepair OFF everywhere), YAML scalar
 * encoding (no newline/config injection), and write/parse round-trips.
 * Pure built-ins; runs without node_modules.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	parseKeepaliveConfig,
	writeKeepaliveConfig,
	parseLlmConfig,
	renderRepairRuntimeSettings,
	yamlString
} from "../lib/llm-config.mjs";
import { makeChecks } from "./helpers.mjs";

const { check, done } = makeChecks("llm-config");
const base = mkdtempSync(join(tmpdir(), "ka-llm-test-"));

try {
	/* ---- defaults ---- */
	const minimal = parseKeepaliveConfig("keepalive:\n  enabled: true\n");
	check(minimal !== null && minimal.autoRepair === false, "autoRepair defaults to false when the section omits it");
	check(minimal !== null && minimal.enabled === true, "enabled still parses");
	const absent = parseKeepaliveConfig("permission:\n  defaultPreset: read-only\n");
	check(absent === null, "no keepalive section parses to null");
	const empty = parseKeepaliveConfig("keepalive:\n  repairProvider:\n");
	check(empty !== null && empty.repairProvider === "", "empty string field parses to empty string, not 0");

	/* ---- scalar encoding: injection attempts ---- */
	const evil = {
		enabled: true,
		autoRepair: false,
		repairProvider: 'evil" # comment\n  enabled: true\nbogus: x',
		repairModel: "deepseek-v4-flash\\model",
		checkIntervalMs: 5000,
		bootWaitMs: 25000
	};
	const doc = writeKeepaliveConfig("permission:\n  defaultPreset: read-only\n", evil);
	const block = doc.split("keepalive:\n")[1].split("\n").slice(0, 6);
	check(block.every((line) => line.startsWith("  ")), "every keepalive block line stays two-space indented (no injected keys/newlines)");
	check(!doc.includes('\n  enabled: true\nbogus: x'), "raw newline from the value did not leak into the document");

	const parsed = parseKeepaliveConfig(doc);
	check(parsed !== null && parsed.repairProvider === evil.repairProvider, "quotes/newline/#/colon value round-trips through parse");
	check(parsed !== null && parsed.repairModel === evil.repairModel, "backslash value round-trips through parse");
	check(parsed !== null && parsed.autoRepair === false && parsed.enabled === true, "booleans round-trip");

	/* replacing an existing section keeps the rest of the document intact */
	const withTail = writeKeepaliveConfig(
		"permission:\n  defaultPreset: read-only\nkeepalive:\n  enabled: false\n  autoRepair: false\n  repairProvider: \"old\"\n  repairModel: \"\"\n  checkIntervalMs: 1000\n  bootWaitMs: 1000\nother:\n  x: 1\n",
		{ enabled: true, autoRepair: true, repairProvider: "a\"b", repairModel: "m", checkIntervalMs: 1, bootWaitMs: 2 }
	);
	check(withTail.includes("keepalive:"), "writer produced a keepalive section");
	check(/^permission:\n  defaultPreset: read-only\n/m.test(withTail), "sections before keepalive are preserved");
	check(withTail.includes("other:\n  x: 1"), "sections after keepalive are preserved when the section is replaced");
	check(withTail.includes('repairProvider: "a\\"b"'), "embedded quote encoded as JSON escape");
	check(withTail.includes("autoRepair: true"), "autoRepair only true when explicitly true");

	/* absent booleans must never coerce to true */
	const coerced = writeKeepaliveConfig("", { enabled: true, repairProvider: "", repairModel: "" });
	check(coerced.includes("autoRepair: false"), "missing autoRepair writes false, never true");

	/* ---- yamlString ---- */
	check(yamlString("plain") === '"plain"', "yamlString quotes plain text");
	check(yamlString('a"b\\c\nd') === '"a\\"b\\\\c\\nd"', "yamlString escapes quotes/backslashes/newlines");
	check(yamlString(void 0) === '""', "yamlString(undefined) is an empty quoted scalar");
	check(!yamlString("x\ny").includes("\n"), "yamlString output is always a single line");

	/* ---- repair runtime settings ---- */
	const repair = renderRepairRuntimeSettings({
		model: "deepseek-v4-flash\n  enabled: true",
		keyEnv: 'BENDI_API_KEY" # x',
		api: "openai-completions",
		baseURL: "https://api.example.com/v1"
	});
	const repairLines = repair.split("\n");
	check(repairLines.every((line) => /^(permission|agent-default-model|llm-pi-ai|  |    |      |        )/.test(line)), "repair settings lines are all structurally indented (no injection)");
	check(repair.includes('model: "deepseek-v4-flash\\n  enabled: true"'), "repair model encoded as one-line JSON literal");
	check(repair.includes('apiKeyEnv: "BENDI_API_KEY\\" # x"'), "repair apiKeyEnv encoded safely");
	check(repair.includes('baseURL: "https://api.example.com/v1"'), "repair baseURL encoded");
	check(repair.includes('reasoningEffort: "max"'), "repair runtime requests max reasoning effort by default");
	check(repair.split("\n").length === 26, "repair settings have exactly the 26 canonical lines (no injected line breaks)");

	/* ---- llm config parse: quoted and unquoted values ---- */
	const llm = parseLlmConfig([
		"agent-default-model:",
		'  provider: "bendi"',
		"  model: deepseek-v4-flash",
		"llm-pi-ai:",
		"  providers:",
		"    bendi:",
		'      api: "openai-completions"',
		'      baseURL: "https://api.example.com"',
		"      apiKeyEnv: BENDI_API_KEY",
		"      models:",
		"        - id: deepseek-v4-flash"
	].join("\n"));
	check(llm !== void 0 && llm.provider === "bendi" && llm.model === "deepseek-v4-flash", "agent-default-model parses quoted + unquoted values");
	check(llm !== void 0 && llm.providers.bendi.baseURL === "https://api.example.com" && llm.providers.bendi.apiKeyEnv === "BENDI_API_KEY", "provider values decode quotes and comments");
} finally {
	rmSync(base, { recursive: true, force: true });
}

process.exit(done() ? 0 : 1);
