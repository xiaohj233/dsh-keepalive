/**
 * llm-config — shared parser for the user's settings.yaml configuration:
 * the LLM stack (agent-default-model + llm-pi-ai providers) and the
 * `keepalive:` section (the source of truth for the keep-alive feature).
 *
 * Used by the host side (status API, settings sync), the client card
 * (via the status API), and the watchdog (repair runtime settings, enabled
 * polling). Deliberately depends only on Node built-ins and plain string
 * parsing: the watchdog must work when dsh itself cannot boot.
 *
 * Writing: every user/config-derived string is emitted as a JSON string
 * literal (`JSON.stringify`), which is a valid YAML double-quoted scalar.
 * That keeps quotes, backslashes, `#`, `:` and even newlines inside one
 * single-line scalar, so a value can never inject a new key or a comment
 * into the document.
 */

/**
 * Encode one string as a YAML double-quoted scalar (a JSON string literal
 * is always valid YAML). Newlines become `\n` escapes, so the emitted text
 * is always a single line.
 * @param {unknown} value
 * @returns {string} the quoted YAML scalar.
 */
export function yamlString(value) {
	return JSON.stringify(String(value ?? ""));
}

/**
 * Decode one YAML scalar captured by the regex parsers: double-quoted JSON
 * strings decode with JSON.parse (mirroring what the writer emits and what a
 * real YAML parser would produce), plain scalars keep their first token and
 * lose a trailing comment.
 * @param {string} raw - trimmed scalar text.
 * @returns {string}
 */
function decodeScalar(raw) {
	if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
		try {
			return JSON.parse(raw);
		} catch {
			/* not a valid JSON literal — fall through to plain handling */
		}
	}
	return raw.split(/\s+/)[0].replace(/#.*$/, "");
}

/**
 * Parse the keepalive section out of a settings.yaml document.
 * @param {string} text - raw settings.yaml content.
 * @returns {null | { enabled: boolean, autoRepair: boolean, repairProvider: string, repairModel: string, checkIntervalMs: number, bootWaitMs: number }}
 */
export function parseKeepaliveConfig(text) {
	try {
		/* The body ends at the next top-level key (`^\S`) or at the absolute
		 * end of the document (`(?![\s\S])`). A trailing `\s*$` alternative
		 * would be WRONG here — with the m flag `$` matches before every
		 * newline, so the body would stop after its first line and every
		 * field but `enabled` would silently fall back to defaults. */
		const m = text.match(/^keepalive:[^\r\n]*\r?\n([\s\S]*?)(?=^\S|(?![\s\S]))/m);
		if (m === null) return null;
		const body = m[1];
		const get = (key, fallback) => {
			const kv = body.match(new RegExp(`^\\s{2}${key}:\\s*(.*)$`, "m"));
			if (kv === null) return fallback;
			const raw = kv[1].trim();
			if (raw === "true") return true;
			if (raw === "false") return false;
			const decoded = decodeScalar(raw);
			if (decoded === "") return "";
			const n = Number(decoded);
			if (Number.isFinite(n)) return n;
			return decoded;
		};
		return {
			enabled: get("enabled", false),
			autoRepair: get("autoRepair", false),
			repairProvider: get("repairProvider", ""),
			repairModel: get("repairModel", ""),
			checkIntervalMs: get("checkIntervalMs", 5000),
			bootWaitMs: get("bootWaitMs", 25000)
		};
	} catch {
		return null;
	}
}

/**
 * Serialize the keepalive section back into a settings.yaml document:
 * replaces an existing `keepalive:` section or appends one at the end.
 * String fields are emitted as JSON string literals (safe YAML double-quoted
 * scalars); booleans are written explicitly so an absent field can never
 * coerce to true.
 * @param {string} text - raw settings.yaml content.
 * @param {object} patch - keepalive section fields to write.
 * @returns {string} the updated document.
 */
export function writeKeepaliveConfig(text, patch) {
	const section = [
		"keepalive:",
		`  enabled: ${patch.enabled === true}`,
		`  autoRepair: ${patch.autoRepair === true}`,
		`  repairProvider: ${yamlString(patch.repairProvider)}`,
		`  repairModel: ${yamlString(patch.repairModel)}`,
		`  checkIntervalMs: ${Number(patch.checkIntervalMs) || 5000}`,
		`  bootWaitMs: ${Number(patch.bootWaitMs) || 25000}`
	].join("\n");
	const existing = text.match(/^keepalive:[^\n]*\n?(?:[ \t].*\n?)*/m);
	if (existing !== null) return text.slice(0, existing.index) + section + text.slice(existing.index + existing[0].length);
	const trimmed = text.replace(/\s+$/, "");
	return trimmed === "" ? section : `${trimmed}\n${section}\n`;
}

/**
 * Parse the LLM configuration out of a settings.yaml document.
 * @param {string} text - raw settings.yaml content.
 * @returns {{ provider: string, model: string, providers: Object<string, {api: string, baseURL: string, apiKeyEnv: string, models: string[]}> } | undefined}
 */
export function parseLlmConfig(text) {
	try {
		const lines = text.split(/\r?\n/);
		let provider;
		let model;
		const admIdx = lines.findIndex((l) => /^agent-default-model:/.test(l));
		if (admIdx !== -1) {
			for (let i = admIdx + 1; i < lines.length; i += 1) {
				const m = lines[i].match(/^\s{2}(provider|model):\s*(.*)$/);
				if (m) {
					const value = decodeScalar(m[2].trim());
					if (m[1] === "provider") provider = value;
					else model = value;
				} else if (/^\S/.test(lines[i])) break;
			}
		}
		const providers = {};
		const llmIdx = lines.findIndex((l) => /^llm-pi-ai:/.test(l));
		if (llmIdx !== -1) {
			let cur = null;
			for (let i = llmIdx + 1; i < lines.length; i += 1) {
				const line = lines[i];
				if (/^\S/.test(line) && line.trim() !== "") break; /* next top-level section */
				const prov = line.match(/^\s{4}(\S[^:]*):\s*$/);
				if (prov) {
					cur = prov[1].trim();
					providers[cur] = { api: void 0, baseURL: void 0, apiKeyEnv: void 0, models: [] };
					continue;
				}
				if (cur === null) continue;
				const kv = line.match(/^\s{6}(api|baseURL|apiKeyEnv):\s*(.*)$/);
				if (kv) providers[cur][kv[1]] = decodeScalar(kv[2].trim());
				const mid = line.match(/^\s{8}-\s*id:\s*(.*)$/);
				if (mid) providers[cur].models.push(decodeScalar(mid[1].trim()));
			}
		}
		return { provider: provider ?? "bendi", model: model ?? "deepseek-v4-flash", providers };
	} catch {
		return void 0;
	}
}

/**
 * Render the settings.yaml for a temporary repair runtime (a clean dsh-base
 * with one `repair` provider and a workspace-write permission preset).
 * Every value derived from the user's real configuration is emitted as a
 * JSON string literal so it cannot inject keys, comments, or newlines into
 * the generated document.
 * @param {{ model: string, keyEnv: string, api: string, baseURL: string }} opts
 * @returns {string} the settings.yaml document.
 */
export function renderRepairRuntimeSettings(opts) {
	return [
		"permission:",
		"  defaultPreset: keepalive-plugin-repair",
		"  presets:",
		"    keepalive-plugin-repair:",
		"      sandbox: workspace-write",
		"      approval: never",
		"      name: keepalive-plugin-repair",
		'      description: "Repair agent: writable plugin workspace; changes are snapshot-audited and rolled back."',
		"agent-default-model:",
		"  provider: repair",
		`  model: ${yamlString(opts.model)}`,
		"llm-pi-ai:",
		"  providers:",
		"    repair:",
		"      displayName: keepalive repair",
		`      apiKeyEnv: ${yamlString(opts.keyEnv)}`,
		`      api: ${yamlString(opts.api)}`,
		`      baseURL: ${yamlString(opts.baseURL)}`,
		"      models:",
		`        - id: ${yamlString(opts.model)}`
	].join("\n");
}
