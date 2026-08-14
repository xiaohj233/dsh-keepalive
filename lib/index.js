/**
 * dsh-keepalive — host side.
 *
 * Source of truth for keep-alive configuration is the `keepalive:` section
 * of settings.yaml (edited from the official Settings → Plugins page, where
 * this plugin renders a configuration card). The host declares that section
 * through dsh-settings, mirrors it into keepalive.json for the watchdog, and
 * makes sure the standalone watchdog process is running while enabled.
 *
 * The watchdog (`../watchdog.mjs`) is a detached Node process: it survives
 * this web process's death, so it can relaunch the web process after crashes
 * and (when a relaunch fails) call dsh's own agent to diagnose and fix the
 * failure. The repair agent runs with a workspace-write preset scoped to the
 * plugins directory — a convenience scope, not a full isolation boundary;
 * the watchdog's snapshot/diff/rollback layer is the actual enforcement.
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";
import { parseKeepaliveConfig, parseLlmConfig, writeKeepaliveConfig } from "./llm-config.mjs";
import { ensureInstalledPatches, resolveDshRootFromBin } from "./installed-patches.mjs";

const name = "dsh-keepalive";
const inject = ["webServer", "loader"];

/** Cordis-level fallbacks; the settings.yaml `keepalive:` section wins. */
const Config = z.object({
	checkIntervalMs: z.number().default(5000),
	bootWaitMs: z.number().default(25000)
});

/** The settings.yaml `keepalive:` section — the source of truth. */
const KEEPALIVE_NS = settingsNamespace("keepalive");
const KeepaliveSettings = z.object({
	enabled: z.boolean().default(false),
	autoRepair: z.boolean().default(false),
	repairProvider: z.string().default(""),
	repairModel: z.string().default(""),
	checkIntervalMs: z.number().default(5000),
	bootWaitMs: z.number().default(25000)
});

const DSH_HOME = resolveDshHome();
const SETTINGS_FILE = join(DSH_HOME, "settings.yaml");
const STATE_FILE = join(DSH_HOME, "keepalive.json");
const LOG_FILE = join(DSH_HOME, "keepalive.log");
const WEB_LOG = join(DSH_HOME, "keepalive-web.log");
const WATCHDOG = fileURLToPath(new URL("../watchdog.mjs", import.meta.url));

function readState() {
	try {
		return JSON.parse(readFileSync(STATE_FILE, "utf8"));
	} catch {
		return {};
	}
}

function writeState(patch) {
	const merged = { ...readState(), ...patch, updatedAt: Date.now() };
	const tmp = STATE_FILE + ".tmp";
	try {
		writeFileSync(tmp, JSON.stringify(merged, null, 2));
		renameSync(tmp, STATE_FILE);
	} catch (error) {
		void error;
	}
}

/** Read the keepalive section from settings.yaml directly (file is the truth). */
function readKeepaliveSection() {
	try {
		return parseKeepaliveConfig(readFileSync(SETTINGS_FILE, "utf8"));
	} catch {
		return null;
	}
}

/** Write the keepalive section into settings.yaml (text-level, atomic-ish). */
function writeKeepaliveSection(patch) {
	try {
		const text = readFileSync(SETTINGS_FILE, "utf8");
		const next = writeKeepaliveConfig(text, patch);
		const tmp = SETTINGS_FILE + ".keepalive-tmp";
		writeFileSync(tmp, next);
		renameSync(tmp, SETTINGS_FILE);
		return true;
	} catch (error) {
		ctxLogger?.warn(`[dsh-keepalive] settings write failed: ${String(error)}`);
		return false;
	}
}

let ctxLogger = null;
let keepaliveScope = null;
let keepaliveRegisterError = null;

function watchdogAlive(state) {
	if (state?.watchdogPid === void 0) return false;
	try {
		process.kill(state.watchdogPid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Start the detached watchdog if it is not already running. */
function ensureWatchdog() {
	const state = readState();
	const bin = process.argv[1];
	if (typeof bin !== "string" || !bin.endsWith("bin.js")) return { ok: false, error: "cannot locate dsh bin.js (argv[1] missing)" };
	if (watchdogAlive(state)) {
		writeState({ dshBin: bin });
		return { ok: true, already: true, pid: state.watchdogPid };
	}
	const child = spawn(process.execPath, [WATCHDOG, bin], {
		detached: true,
		stdio: "ignore",
		windowsHide: true
	});
	child.unref();
	writeState({ watchdogPid: child.pid, dshBin: bin });
	return { ok: true, pid: child.pid };
}

function statusPayload() {
	const state = readState();
	const section = readKeepaliveSection();
	const llm = parseLlmConfig(readSettingsText() ?? "");
	const providers = llm === void 0
		? []
		: Object.entries(llm.providers).map(([name, p]) => ({ name, models: p.models }));
	return {
		enabled: (section?.enabled ?? state.enabled) === true,
		status: state.status ?? "watching",
		watchdogAlive: watchdogAlive(state),
		webPid: state.webPid ?? null,
		lastRestoredAt: state.lastRestoredAt ?? null,
		repairCount: state.repairCount ?? 0,
		lastError: state.lastError ?? null,
		updatedAt: state.updatedAt ?? null,
		repair: {
			autoRepair: section?.autoRepair ?? state.autoRepair ?? false,
			repairProvider: section?.repairProvider ?? state.repairProvider ?? "",
			repairModel: section?.repairModel ?? state.repairModel ?? ""
		},
		providers
	};
}

function readSettingsText() {
	try {
		return readFileSync(SETTINGS_FILE, "utf8");
	} catch {
		return void 0;
	}
}

/** Mirror the settings section into keepalive.json so the watchdog sees it. */
function syncStateFromSection(section) {
	if (section === null) return;
	writeState({
		enabled: section.enabled,
		autoRepair: section.autoRepair,
		repairProvider: section.repairProvider,
		repairModel: section.repairModel
	});
}

function tail(file, lines = 120, maxBytes = 64 * 1024) {
	try {
		const buf = readFileSync(file);
		const start = Math.max(0, buf.length - maxBytes);
		const parts = buf.subarray(start).toString("utf8").split("\n").filter((l) => l.length > 0);
		return parts.slice(-lines).join("\n");
	} catch {
		return "(no log yet)";
	}
}

function json(res, code, body) {
	res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
	try {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
	} catch {
		return null;
	}
}

function apply(ctx, config) {
	ctxLogger = ctx.logger;
	/* Apply the installed-package patches (settings-namespace exposure +
	 * windowsHide) at host startup, BEFORE the settings card can be used:
	 * without the apiproxy allowlist entry the card can neither read nor
	 * save even though the namespace is registered, and this must not depend
	 * on the watchdog already running. Idempotent and version-guarded — see
	 * lib/installed-patches.mjs. A failure here is logged, never fatal: the
	 * host keeps running, and the card simply cannot save until the patch
	 * applies (e.g. after a DSH upgrade the guard refuses a changed package
	 * version instead of corrupting it).
	 *
	 * Ordinary shutdown is NOT an uninstall: the patches are never reverted
	 * when this fiber is disposed. Official files are restored only by the
	 * explicit uninstall command (bin/uninstall.mjs) or
	 * `watchdog.mjs --unpatch <bin>`.
	 */
	const argvBin = typeof process.argv[1] === "string" ? process.argv[1] : void 0;
	if (argvBin !== void 0 && argvBin.endsWith("bin.js")) {
		const located = resolveDshRootFromBin(argvBin);
		if (located.ok) {
			const applied = ensureInstalledPatches({
				dshRoot: located.root,
				log: (line) => ctx.logger?.info(`[dsh-keepalive] ${line}`)
			});
			if (!applied.ok) {
				ctx.logger?.warn(`[dsh-keepalive] installed-package patches incomplete: ${applied.results.map((r) => `${r.package}: ${r.reason}`).join("; ")}`);
			}
		} else {
			ctx.logger?.warn(`[dsh-keepalive] cannot resolve dsh root from bin (${argvBin}): ${located.error}`);
		}
	} else {
		ctx.logger?.info("[dsh-keepalive] no dsh bin.js in argv — installed-package patches not applied from this context");
	}
	const base = {
		enabled: false,
		autoRepair: false,
		repairProvider: "",
		repairModel: "",
		checkIntervalMs: config.checkIntervalMs,
		bootWaitMs: config.bootWaitMs
	};
	/* Register the `keepalive:` settings section directly on the settings
	 * service (same underlying register call installSettingsSection makes,
	 * but with try/catch diagnostics: the injection callback runs
	 * asynchronously and a failure there would leave the section unregistered,
	 * which makes the client card unable to save). */
	ctx.inject(["settings"], (sctx) => {
		try {
			const scope = sctx.settings.register(KEEPALIVE_NS, KeepaliveSettings, { base });
			keepaliveScope = scope;
			keepaliveRegisterError = null;
			scope.watch(() => {
				const section = readKeepaliveSection();
				syncStateFromSection(section);
				if ((section?.enabled ?? false) === true) {
					const started = ensureWatchdog();
					ctx.logger?.info(`[dsh-keepalive] settings change: watchdog ${started.ok ? (started.already ? "already running" : `started (pid ${started.pid})`) : `start failed: ${started.error}`}`);
				}
			});
			ctx.logger?.info("[dsh-keepalive] settings scope registered");
		} catch (error) {
			keepaliveRegisterError = String(error);
			ctx.logger?.warn(`[dsh-keepalive] settings scope register failed: ${String(error)}`);
		}
	});

	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/api/keepalive/status",
		handler: async (_req, res) => json(res, 200, statusPayload())
	}), "dsh-keepalive: /api/keepalive/status");

	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/api/keepalive/debug",
		handler: async (_req, res) => json(res, 200, {
			scopeRegistered: keepaliveScope !== null,
			registerError: keepaliveRegisterError,
			section: readKeepaliveSection()
		})
	}), "dsh-keepalive: /api/keepalive/debug");

	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/api/keepalive/toggle",
		handler: async (_req, res) => {
			const section = readKeepaliveSection() ?? base;
			const enabled = !section.enabled;
			writeKeepaliveSection({ ...section, enabled });
			syncStateFromSection({ ...section, enabled });
			if (enabled) {
				const started = ensureWatchdog();
				ctx.logger?.info(`[dsh-keepalive] enabled; watchdog ${started.ok ? (started.already ? `already running (pid ${started.pid})` : `started (pid ${started.pid})`) : `start failed: ${started.error}`}`);
			} else {
				ctx.logger?.info("[dsh-keepalive] disabled (watchdog keeps polling the state file)");
			}
			json(res, 200, statusPayload());
		}
	}), "dsh-keepalive: /api/keepalive/toggle");

	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/api/keepalive/config",
		handler: async (req, res) => {
			const body = await readJsonBody(req);
			if (body === null) {
				json(res, 400, { error: "invalid json body" });
				return;
			}
			const section = readKeepaliveSection() ?? base;
			const next = { ...section };
			if (typeof body.autoRepair === "boolean") next.autoRepair = body.autoRepair;
			if (typeof body.repairProvider === "string") next.repairProvider = body.repairProvider;
			if (typeof body.repairModel === "string") next.repairModel = body.repairModel;
			if (typeof body.checkIntervalMs === "number") next.checkIntervalMs = body.checkIntervalMs;
			if (typeof body.bootWaitMs === "number") next.bootWaitMs = body.bootWaitMs;
			writeKeepaliveSection(next);
			syncStateFromSection(next);
			ctx.logger?.info(`[dsh-keepalive] config updated: ${JSON.stringify(next)}`);
			json(res, 200, statusPayload());
		}
	}), "dsh-keepalive: /api/keepalive/config");

	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/api/keepalive/log",
		handler: async (_req, res) => {
			res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
			res.end(tail(WEB_LOG, 120));
		}
	}), "dsh-keepalive: /api/keepalive/log");

	/* After the tree settles, mirror the section and make sure the watchdog is
	supervising whenever keep-alive was left enabled (e.g. the machine was
	rebooted and the user started web manually — the watchdog then owns the
	relaunch duty again). */
	(async () => {
		try {
			await Promise.race([
				ctx.get("loader")?.await() ?? Promise.resolve(),
				new Promise((resolve) => setTimeout(resolve, 20000))
			]);
		} catch {
			/* a missing loader (non-boot context) means nothing to wait for */
		}
		const section = readKeepaliveSection();
		syncStateFromSection(section);
		if ((section?.enabled ?? false) === true) {
			try {
				const started = ensureWatchdog();
				ctx.logger?.info(`[dsh-keepalive] boot: keep-alive enabled, watchdog ${started.ok ? (started.already ? "already running" : "started") : `start failed: ${started.error}`}`);
			} catch (error) {
				ctx.logger?.warn(`[dsh-keepalive] watchdog start failed: ${String(error)}`);
			}
		} else {
			ctx.logger?.info("[dsh-keepalive] boot: keep-alive disabled (enable it from Settings → Plugins → 保活)");
		}
	})();
}

export { Config, apply, inject, name };
