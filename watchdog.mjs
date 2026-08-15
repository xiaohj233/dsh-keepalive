#!/usr/bin/env node
/**
 * dsh-keepalive watchdog — standalone supervisor for the dsh web process.
 *
 * Deliberately depends only on Node built-ins (plus the plugin's own lib
 * modules): it must keep working when dsh web itself is broken or down. The
 * web host plugin spawns it detached (it survives the web process's death)
 * and it supervises by polling the state file `$DSH_HOME/keepalive.json`:
 *
 *   - enabled=false  → watch only, never touch anything.
 *   - enabled=true   → every `checkIntervalMs` verify the web HTTP port
 *     answers; when it does not, relaunch `node <bin.js> web` detached with
 *     stdout/stderr appended to `$DSH_HOME/keepalive-web.log`.
 *   - relaunch fails (port still silent after `bootWaitMs`) → one repair pass:
 *     1. collect the complete output of the failed real launch plus diagnostics
 *     2. ask dsh's own agent: `node <bin.js> --profile headless "<task>"`
 *        running in a temporary repair DSH_HOME with cwd set to the plugin
 *        directory, timeout guarded
 *     3. validate that only plugin files changed, every changed JS/MJS passes
 *        `node --check`, and the profile config still parses
 *     4. relaunch web exactly once; success is the port answering. Any failed
 *        gate or failed final launch rolls the plugin tree back to its
 *        snapshot and transitions to `failed` — no repeated repair loop.
 *
 * The repair agent runs under a workspace-write permission preset with its
 * session cwd set to the plugin directory. That preset is a convenience
 * scope, NOT a full isolation boundary — the snapshot/diff/rollback layer
 * and the post-repair gates are the enforcement. There is no raw-LLM
 * file-writing fallback.
 *
 * Installed-package patches (settings-namespace exposure, windowsHide) are
 * applied here at startup as well as by the host plugin, so a watchdog that
 * survives a DSH reinstall re-applies them. Ordinary shutdown is NOT an
 * uninstall: official files are only restored by the explicit uninstall
 * command (`bin/uninstall.mjs`) or this watchdog's `--unpatch` mode.
 *
 * Usage: node watchdog.mjs <bin-js-path> [state-file] [log-file] [web-log]
 *        node watchdog.mjs --unpatch <bin-js-path>
 */

import { readFileSync, writeFileSync, renameSync, appendFileSync, mkdirSync, openSync, rmSync, existsSync, copyFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import http from "node:http";
import { parseKeepaliveConfig, parseLlmConfig, renderRepairRuntimeSettings } from "./lib/llm-config.mjs";
import { ensureInstalledPatches, restoreInstalledPatches, resolveDshRootFromBin } from "./lib/installed-patches.mjs";
import { takeSnapshot, diffSnapshot, restoreSnapshot as rollbackSnapshot, linkTargetDirs } from "./lib/snapshot-rollback.mjs";
import { createRepairPage } from "./lib/repair-page.mjs";

const BIN = process.argv[2];
const DSH_HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? "C:\\Users\\", ".dsh");
const STATE = process.argv[3] ?? join(DSH_HOME, "keepalive.json");
const LOG = process.argv[4] ?? join(DSH_HOME, "keepalive.log");
const WEB_LOG = process.argv[5] ?? join(DSH_HOME, "keepalive-web.log");
const PORT = 3080;
const HOST = "127.0.0.1";

function log(line) {
	try {
		appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
	} catch {
		/* best-effort */
	}
}

function now() {
	return Date.now();
}

function readState() {
	try {
		return JSON.parse(readFileSync(STATE, "utf8"));
	} catch {
		return {};
	}
}

/**
 * Effective keep-alive configuration: the settings.yaml `keepalive:` section
 * is the source of truth; keepalive.json fields fill in when the section is
 * absent (e.g. an older install). autoRepair defaults to FALSE everywhere —
 * the repair agent must be explicitly opted into.
 */
function effectiveConfig() {
	const state = readState();
	let section = null;
	try {
		section = parseKeepaliveConfig(readFileSync(join(DSH_HOME, "settings.yaml"), "utf8"));
	} catch {
		section = null;
	}
	if (section === null) {
		return {
			enabled: state.enabled === true,
			autoRepair: state.autoRepair === true,
			repairProvider: state.repairProvider ?? "",
			repairModel: state.repairModel ?? "",
			checkIntervalMs: Number(state.checkIntervalMs) || 5000,
			bootWaitMs: Number(state.bootWaitMs) || 25000,
			state
		};
	}
	return {
		enabled: section.enabled,
		autoRepair: section.autoRepair,
		repairProvider: section.repairProvider,
		repairModel: section.repairModel,
		checkIntervalMs: Number(section.checkIntervalMs) || 5000,
		bootWaitMs: Number(section.bootWaitMs) || 25000,
		state
	};
}

function writeState(patch) {
	const merged = { ...readState(), ...patch, updatedAt: now() };
	const tmp = STATE + ".tmp";
	try {
		writeFileSync(tmp, JSON.stringify(merged, null, 2));
		renameSync(tmp, STATE);
	} catch (error) {
		log(`state write failed: ${String(error)}`);
	}
}

/** Single-instance guard: exit quietly when another watchdog holds the file. */
function claim() {
	const state = readState();
	if (state.watchdogPid !== void 0 && state.watchdogPid !== process.pid) {
		try {
			process.kill(state.watchdogPid, 0);
			log(`another watchdog (pid ${state.watchdogPid}) is alive — exiting`);
			process.exit(0);
		} catch {
			/* stale pid — take over */
		}
	}
	writeState({ watchdogPid: process.pid, status: "watching" });
	log(`watchdog started (pid ${process.pid}), supervising http://${HOST}:${PORT}`);
}

/** Is the web HTTP port answering? */
function webAlive(timeoutMs = 3000) {
	return new Promise((resolveAlive) => {
		const req = http.get({ host: HOST, port: PORT, path: "/", timeout: timeoutMs }, (res) => {
			res.resume();
			resolveAlive(res.statusCode !== void 0);
		});
		req.on("timeout", () => {
			req.destroy();
			resolveAlive(false);
		});
		req.on("error", () => resolveAlive(false));
	});
}

/** Find the pid listening on the web port via netstat (no PowerShell — a
 * PowerShell child process showed up as a popup window on this machine). */
function portPid() {
	try {
		const res = spawnSync("netstat", ["-ano"], { encoding: "utf8", timeout: 8000, windowsHide: true });
		const lines = (res.stdout ?? "").split(/\r?\n/);
		for (const line of lines) {
			// TCP    0.0.0.0:3080    0.0.0.0:0    LISTENING    12345
			// TCP    [::]:3080       [::]:0       LISTENING    12345
			const m = line.match(/^\s*TCP\s+(\S+):(\d+)\s+(\S+):(\d+)\s+LISTENING\s+(\d+)$/i);
			if (m === null) continue;
			if (Number(m[2]) !== PORT || Number(m[4]) !== 0) continue;
			const pid = Number.parseInt(m[5], 10);
			if (Number.isFinite(pid) && pid > 0) return pid;
		}
	} catch {
		/* best-effort */
	}
	return void 0;
}

function killTree(pid) {
	try {
		spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 8000, windowsHide: true });
	} catch {
		/* best-effort */
	}
}

/** Relaunch web detached; logs go to the web log file. */
function launchWeb() {
	let fd;
	try {
		fd = openSync(WEB_LOG, "a");
	} catch (error) {
		log(`web log open failed: ${String(error)}`);
		return void 0;
	}
	const marker = `\n=== dsh-keepalive launch attempt ${new Date().toISOString()} pid ${process.pid} ===\n`;
	writeFileSync(fd, marker);
	const logStart = readFileSync(WEB_LOG).length;
	const child = spawn(process.execPath, [BIN, "web"], {
		detached: true,
		stdio: ["ignore", fd, fd],
		windowsHide: true
	});
	child.unref();
	log(`web relaunch requested (pid ${child.pid})`);
	writeState({ status: "restoring", webPid: child.pid, lastError: null });
	return { pid: child.pid, logStart, startedAt: now() };
}

/**
 * Read the complete bytes a launch attempt wrote to the web log after its
 * marker: the full stdout/stderr of that process, not just the tail.
 */
function attemptOutput(logStart) {
	try {
		const buf = readFileSync(WEB_LOG);
		const start = Math.max(0, Math.min(logStart, buf.length));
		return buf.subarray(start).toString("utf8");
	} catch {
		return "";
	}
}

/** Tail a text file, newest `lines` lines. */
function tail(file, lines = 120, maxBytes = 64 * 1024) {
	try {
		const buf = readFileSync(file);
		const start = Math.max(0, buf.length - maxBytes);
		const text = buf.subarray(start).toString("utf8");
		const parts = text.split("\n").filter((l) => l.length > 0);
		return parts.slice(-lines).join("\n");
	} catch {
		return `(no log at ${file})`;
	}
}

/** Wait until the port answers or the timeout elapses. */
async function waitAlive(ms) {
	const deadline = now() + ms;
	while (now() < deadline) {
		if (await webAlive(2000)) return true;
		await sleep(1500);
	}
	return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Build a temporary repair DSH_HOME so the headless repair agent runs on a
 * clean dsh-base without the user's web profile, plugins, resume state, or
 * global settings. Returns the temp dir, or null when it cannot be prepared
 * safely (callers must then fail the repair instead of degrading).
 *
 * The generated settings.yaml encodes every user-derived value (model,
 * apiKeyEnv, api, baseURL) as a JSON string literal, so a value from the
 * user's configuration can never inject keys, comments, or newlines into
 * the repair runtime's settings.
 *
 * @param opts - { provider?, model? } preferred repair model (from the
 * keepalive plugin config); falls back to the active agent-default-model.
 */
function prepareRepairRuntime(attemptId, opts = {}) {
	const dir = join(HOME, "keepalive-repair-runtime", attemptId);
	try {
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(join(dir, "profiles"), { recursive: true });
		mkdirSync(join(dir, "sessions"), { recursive: true });
		const llm = readSettings();
		if (llm === void 0) return null;
		const chosen = opts.provider !== void 0 && opts.provider !== "" && llm.providers[opts.provider] !== void 0
			? opts.provider
			: (llm.providers[llm.provider] !== void 0 ? llm.provider : Object.keys(llm.providers)[0]);
		const prov = llm.providers[chosen];
		if (prov === void 0) return null;
		const model = (opts.model !== void 0 && opts.model !== "" && prov.models.includes(opts.model))
			? opts.model
			: (chosen === llm.provider ? llm.model : prov.models[0]);
		if (model === void 0) return null;
		const keyEnv = prov.apiKeyEnv ?? "BENDI_API_KEY";
		const settings = renderRepairRuntimeSettings({
			model,
			keyEnv,
			api: prov.api ?? "openai-completions",
			baseURL: prov.baseURL ?? ""
		});
		writeFileSync(join(dir, "settings.yaml"), settings);
		/* The headless agent must authenticate like the real web profile does:
		   copy the DSH credential file into the isolated runtime. Values stay
		   inside the temporary repair home and are removed when the repair
		   finishes (see headlessRepair). A missing credential file is not
		   fatal here — the agent's own MISSING_CREDENTIAL output then names
		   the gap instead of a silent generic failure. */
		try {
			const credentialsFile = join(DSH_HOME, ".credentials.yaml");
			if (existsSync(credentialsFile)) {
				copyFileSync(credentialsFile, join(dir, ".credentials.yaml"));
				log("repair runtime: credentials copied for headless agent");
			} else {
				log("repair runtime: no credential file to copy — agent may report MISSING_CREDENTIAL");
			}
		} catch (error) {
			log(`repair runtime: credentials copy failed (agent may report MISSING_CREDENTIAL): ${String(error)}`);
		}
	} catch (error) {
		log(`repair runtime prepare failed: ${String(error)}`);
		return null;
	}
	return dir;
}

/** Run one headless repair task in an isolated repair runtime; resolves on exit. */
async function headlessRepair(diagnostics, attemptId, modelOpts) {
	const repairHome = prepareRepairRuntime(attemptId, modelOpts);
	if (repairHome === null) {
		log("repair runtime unavailable — failing repair without touching anything");
		return { ok: false, out: "repair runtime unavailable" };
	}
	/* The headless agent's sandbox is workspace-write rooted at its cwd.
	 * Rooting it at the common parent of every link:/file: dev checkout lets
	 * the agent edit the failing plugin's source (sanctioned since v0.2.8,
	 * snapshot-tracked and rollback-capable); falls back to the web profile
	 * dir when there are no link targets. */
	const workspace = repairWorkspaceRoot();
	const task = [
		`DSH web 的一次真实启动失败。以下是这次真实启动的完整输出：`,
		``,
		diagnostics,
		``,
		`要求：`,
		`1. 先阅读完整错误、相关日志、DSH 官方源码与报错插件的真实文件结构，自行确定根因后再做最小修改；不要凭猜测重写 Config、inject、patch、bundle 或目录结构。`,
		`2. 只应修改用户插件文件：(a) ~/.dsh/plugins 目录，(b) ~/.dsh/profiles/web/node_modules 下以 dsh- 开头的用户插件包（如 dsh-resume、dsh-keepalive、dsh-tavily-search-provider 等，含其 cordis.patch.yml、package.json 等包内文件），(c) 对 web profile package.json 中以 link: 或 file:（目录）声明指向的开发目录：允许在其 node_modules 下新建 junction/symlink 补齐依赖解析（仅限新增条目，用于把官方安装里的 @deepseek-ai/* 等包链接进来），并且允许对【本次报错插件所属的那个开发目录】内的源码做最小修复（例如补变量声明、修正 import 路径、修复语法；禁止删除任何文件，禁止改动与本次故障无关的目录或文件）。禁止修改 node_modules/@deepseek-ai/（官方主框架包）、settings.yaml、profile 配置、session、storage、keepalive 状态或 DSH 官方安装；修改会被快照审计，越界、语法错误或删除文件会被回滚。`,
		`3. 不要删除、移动、重命名文件；不要卸载、清理、重置。`,
		`4. 如果根因不在用户插件，停止修改并用中文说明根因和建议。`,
		`5. 修复后对每个修改过的 .js/.mjs 执行 node --check 自检。`,
		`6. 输出简洁中文总结：根因、修改的文件、验证结果。`,
		`7. 不要启动或重启 web 服务器（外部 watchdog 负责验证）。`,
		`8. 进度汇报：每完成一个重要步骤（分析根因、定位文件、实施修改、自检、总结），输出一行以 [进度] 开头的中文说明，例如：[进度] 已定位根因：缺少 raf 变量声明。这些行会实时展示给用户。`,
		`9. 你的工作区根（workspace-write 沙箱允许写入的根目录）是：${workspace ?? join(HOME, "profiles", "web")}。本次允许修改的 link 目标开发目录是：${linkTargetDirs(HOME).join("；") || "无"}。只在允许范围内写入。`
	].join("\n");
	log("headless repair task started (isolated runtime)");
	const child = spawn(process.execPath, [BIN, "--profile", "headless", task], {
		cwd: workspace ?? join(HOME, "profiles", "web"),
		env: { ...process.env, DSH_HOME: repairHome },
		windowsHide: true,
		stdio: ["ignore", "pipe", "pipe"]
	});
	let out = "";
	child.stdout.on("data", (d) => {
		out += d;
		for (const line of d.toString().split(/\r?\n/)) {
			const t = line.trim();
		if (t) pushRepairProgress(`[agent] ${t}`);
		}
	});
	child.stderr.on("data", (d) => {
		out += d;
		for (const line of d.toString().split(/\r?\n/)) {
			const t = line.trim();
		if (t) pushRepairProgress(`[agent] ${t}`);
		}
	});
	const result = await new Promise((resolveDone) => {
		let timedOut = false;
		const timer = setTimeout(() => {
			killTree(child.pid);
			timedOut = true;
			resolveDone({ code: null, out, timedOut: true });
		}, 900000);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolveDone({ code, out, timedOut: false });
		});
	});
	/* Never leave the user's credentials behind in the isolated runtime. The
	   directory itself is kept for post-mortem diagnostics; only the copied
	   credential file is removed. */
	try {
		rmSync(join(repairHome, ".credentials.yaml"), { force: true });
	} catch {
		/* best-effort */
	}
	log(`headless repair finished code=${result.code} (${result.out.length} chars)${result.timedOut ? " — TIMED OUT after 900s" : ""}`);
	return { ok: result.code === 0, out: result.out.slice(-4000) };
}

/** Common parent directory of every link:/file: dev checkout target, or
 * null when there are none (keeps the workspace-write sandbox as narrow as
 * possible while still covering the sanctioned source-edit targets). */
function repairWorkspaceRoot() {
	const dirs = linkTargetDirs(HOME);
	if (dirs.length === 0) return null;
	let common = dirs[0];
	const parts = (p) => p.split(/[\\/]+/).filter(Boolean);
	for (const dir of dirs.slice(1)) {
		const a = parts(common);
		const b = parts(dir);
		const n = Math.min(a.length, b.length);
		let i = 0;
		while (i < n && a[i].toLowerCase() === b[i].toLowerCase()) i++;
		if (i === 0) return null;
		common = a.slice(0, i).join("\\");
	}
	return common.length >= 3 ? common : null;
}

/**
 * Read the real LLM configuration from the user's settings.yaml via the
 * shared parser. Returns undefined when the file cannot be read.
 */
function readSettings() {
	try {
		return parseLlmConfig(readFileSync(join(DSH_HOME, "settings.yaml"), "utf8"));
	} catch {
		return void 0;
	}
}

const HOME = DSH_HOME;

/* Repair status page: served on the web port while a repair runs. */
const repairPage = createRepairPage({ host: HOST, port: PORT, log });

/* Repair progress is ALSO persisted to a file the running web host reads, so
 * the web UI can show "repairing" progress even in the degraded case (web UP,
 * no repair status page bound — the web owns the port). */
const REPAIR_PROGRESS_FILE = join(HOME, "keepalive-repair-progress.json");
let repairPhase = "idle";
let repairLines = [];
let lastProgressPersist = 0;

function persistRepairProgress(force) {
	const now = Date.now();
	if (!force && now - lastProgressPersist < 3000) return;
	lastProgressPersist = now;
	try {
		writeFileSync(REPAIR_PROGRESS_FILE, JSON.stringify({ phase: repairPhase, lines: repairLines.slice(-60), updatedAt: now }));
	} catch {
		/* best-effort */
	}
}

function pushRepairProgress(line) {
	repairLines.push(line);
	if (repairLines.length > 120) repairLines.shift();
	repairPage.push(line);
	persistRepairProgress(false);
}

function setRepairPhase(phase, extra = {}) {
	repairPhase = phase;
	repairPage.set(phase, extra);
	persistRepairProgress(true);
}

function clearRepairProgress() {
	repairPhase = "idle";
	repairLines = [];
	try {
		rmSync(REPAIR_PROGRESS_FILE, { force: true });
	} catch {
		/* best-effort */
	}
}

/* ------------------------------------------------------------------ */
/* Snapshot / audit / rollback live in lib/snapshot-rollback.mjs —    */
/* the enforcement layer that keeps repair agents from making things   */
/* worse. Independent of dsh itself.                                   */
/* ------------------------------------------------------------------ */

/** One repair pass: headless only, in the isolated runtime. */
async function repairRound(diagnostics, attemptId, modelOpts) {
	const headless = await headlessRepair(diagnostics, attemptId, modelOpts);
	if (headless.ok) return { ok: true, via: "headless", out: headless.out };
	return { ok: false, error: headless.out || "headless repair failed" };
}

/**
 * Shared repair gates: snapshot diff (out-of-bounds/link drift), syntax check
 * of every changed .js/.mjs (including link-target source edits), and a
 * --dump-config sanity probe. Returns { gatesPassed, diff }.
 */
function checkRepairGates(snap, result) {
	setRepairPhase("verifying");
	const diff = diffSnapshot(snap);
	if (diff.outsideDrift.length > 0) {
		log(`repair pass: OUT-OF-BOUNDS drift detected — ${diff.outsideDrift.join("; ")} — failing`);
	}
	if (diff.linkDrift.length > 0) {
		log(`repair pass: link-target drift detected — ${diff.linkDrift.join("; ")} — failing`);
	}
	if (diff.linkAdded.length > 0) {
		log(`repair pass: link-target junction(s) added — ${diff.linkAdded.join("; ")}`);
	}
	const badSyntax = [];
	for (const rel of diff.changed) {
		if (/\.(js|mjs)$/i.test(rel)) {
			let abs;
			if (rel.startsWith("profileplug\\")) {
				const [pkgName, ...rest] = rel.slice("profileplug\\".length).split("\\");
				abs = join(HOME, "profiles", "web", "node_modules", pkgName, ...rest);
			} else if (rel.startsWith("plugins\\")) {
				abs = join(HOME, "plugins", rel.slice("plugins\\".length));
			} else if (rel.startsWith("linkroot\\")) {
				const [idxStr, ...rest] = rel.slice("linkroot\\".length).split("\\");
				abs = join((snap.linkRoots ?? [])[Number(idxStr)] ?? HOME, ...rest);
			} else {
				abs = join(HOME, rel);
			}
			const check = spawnSync(process.execPath, ["--check", abs], {
				timeout: 30000,
				windowsHide: true,
				encoding: "utf8"
			});
			if (check.status !== 0) badSyntax.push(rel);
		}
	}
	if (badSyntax.length > 0) log(`repair pass: syntax gate failed — ${badSyntax.join("; ")}`);
	const dump = spawnSync(process.execPath, [BIN, "--profile", "web", "--dump-config"], {
		timeout: 30000,
		windowsHide: true,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"]
	});
	if (dump.status !== 0) log(`repair pass: config gate failed (--dump-config exit ${dump.status})`);
	const gatesPassed = result.ok && diff.outsideDrift.length === 0 && diff.linkDrift.length === 0 && badSyntax.length === 0 && dump.status === 0;
	return { gatesPassed, diff };
}

/**
 * Degraded repair for a front-end plugin failure reported by the keepalive
 * client while the web process is UP (a plugin failed to load in the
 * browser — the watchdog would never notice from process liveness alone).
 * Runs the same snapshot-audited headless repair, relaunches web so the
 * plugin reloads, and clears the report on success. The repair status page
 * is intentionally NOT started: the web UI is still serving, and binding
 * the port it owns would just EADDRINUSE.
 */
async function runPluginFailureRepair(pf) {
	log(`plugin failure reported — starting degraded repair: ${String(pf.error).slice(0, 120)}`);
	writeState({ status: "repairing", repairCount: 1, lastError: "plugin failure reported; repair in progress" });
	setRepairPhase("detected");
	restoreResumeStateBytes(readResumeStateBytes());
	const attemptId = new Date().toISOString().replace(/[:.]/g, "-");
	/* The web is UP during a degraded repair, so its sessions/storages keep
	 * being written; those live dirs must not be drift-ledgered here (a
	 * launch-failure repair, with the web down, still checks them). */
	const snap = takeSnapshot(HOME, attemptId, { skipLiveDirs: true });
	log(`plugin repair pass: snapshot taken (${Object.keys(snap.ledger).length} files)`);
	setRepairPhase("snapshot");
	const diagnostics = [
		`--- 前端插件加载失败上报（web 进程存活）---`,
		`插件: ${pf.plugin || "(unknown)"}`,
		`错误: ${pf.error}`,
		`上报时间: ${pf.at ?? "(unknown)"}`,
		`注意：web 进程仍然存活，本次故障只在前端（浏览器）加载该插件时发生；下方 web 日志中的历史错误可能已经修复，请以上述上报错误为准，聚焦定位。`,
		`--- 最近 web 日志 ---`,
		tail(WEB_LOG, 30),
		`--- keepalive 状态 ---`,
		JSON.stringify(readState(), null, 2)
	].join("\n");
	const modelCfg = effectiveConfig();
	const modelOpts = { provider: modelCfg.repairProvider ?? "", model: modelCfg.repairModel ?? "" };
	let result;
	if (modelCfg.autoRepair) {
		log(`plugin repair pass: autoRepair on (provider="${modelOpts.provider}" model="${modelOpts.model}")`);
		setRepairPhase("agent-running");
		result = await repairRound(diagnostics, attemptId, modelOpts);
	} else {
		log("plugin repair pass: autoRepair disabled — skipping repair agent");
		setRepairPhase("verifying");
		result = { ok: false, error: "autoRepair disabled" };
	}
	const { gatesPassed, diff } = checkRepairGates(snap, result);
	if (gatesPassed) {
		const noChanges = diff.changed.length === 0 && diff.linkAdded.length === 0;
		if (noChanges) {
			/* The agent made no changes — the report was either a false
			 * positive or already self-healed. Do NOT relaunch the web and
			 * interrupt the user; just clear the report. */
			log("plugin repair pass ok but no changes — clearing report without relaunch");
			writeState({ status: "watching", pluginFailure: void 0, repairCount: 0 });
			clearRepairProgress();
			return true;
		}
		log(`plugin repair pass ok (${result.via}) — relaunching web to reload plugins`);
		launchWeb();
		if (await waitAlive(modelCfg.bootWaitMs)) {
			const fresh = portPid();
			writeState({ status: "watching", pluginFailure: void 0, lastRestoredAt: new Date().toISOString(), repairCount: 0, ...fresh !== void 0 ? { webPid: fresh } : {} });
			setRepairPhase("succeeded");
			clearRepairProgress();
			log("plugin repair ok — web relaunched, plugin failure cleared");
			return true;
		}
		log("plugin repair applied but final relaunch still did not come up");
	} else {
		log(`plugin repair failed: ${result.error ?? result.out}`);
	}
	const rolled = rollbackSnapshot(snap);
	log(`plugin repair rolled back:\n${rolled}`);
	setRepairPhase("failed");
	clearRepairProgress();
	writeState({ status: "failed", pluginFailure: void 0, lastError: "plugin repair failed (see keepalive.log) — report cleared, no further automatic attempts", repairCount: 1 });
	return false;
}

/**
 * dsh-resume consumes resume-state.json at boot (it resets the file before
 * restoring), so a failed web launch must never eat the recorded sessions.
 * These helpers snapshot the file bytes before a real launch and restore
 * them if that launch fails; the final successful launch keeps its state.
 */
function readResumeStateBytes() {
	try {
		return readFileSync(join(HOME, "resume-state.json"));
	} catch {
		return null;
	}
}

function restoreResumeStateBytes(bytes) {
	if (bytes === null) return;
	try {
		writeFileSync(join(HOME, "resume-state.json"), bytes);
	} catch (error) {
		log(`resume-state restore failed: ${String(error)}`);
	}
}

/**
 * Apply the installed-package patches (settings-namespace exposure +
 * windowsHide). v2: every installed copy is decided independently and the
 * engine never throws for installation-state reasons — see
 * lib/installed-patches.mjs. Logged but never fatal here: the watchdog must
 * keep supervising even when the patches cannot be (re)applied.
 */
function applyInstalledPatches() {
	const located = resolveDshRootFromBin(BIN);
	if (!located.ok) {
		log(`cannot resolve dsh root from bin (${BIN}): ${located.error} — installed-package patches not applied`);
		return;
	}
	try {
		const result = ensureInstalledPatches({ dshRoot: located.root, log });
		if (!result.ok) {
			log(`installed patches incomplete: ${result.summary}`);
			for (const entry of result.skipped) {
				if (entry.reason !== "already-patched") {
					log(`  ${entry.package}: ${entry.reason}${entry.detail ? ` (${entry.detail})` : ""}`);
				}
			}
		}
	} catch (error) {
		log(`installed patches threw: ${String(error)} — continuing without patches`);
	}
}

/** Main supervision loop. */
async function main() {
	const args = process.argv.slice(2);
	if (args[0] === "--unpatch") {
		/* Explicit manual unpatch: `node watchdog.mjs --unpatch <bin>`. The
		 * bin path is a required SECOND argument — argv[2] in this mode is
		 * the flag itself, never the bin (the old invocation treated
		 * "--unpatch" as the bin and patched a garbage `.\node_modules`). */
		const bin = args[1];
		if (!bin || bin.startsWith("-")) {
			console.error("usage: node watchdog.mjs --unpatch <dsh-bin-js-path>");
			process.exit(2);
		}
		const located = resolveDshRootFromBin(bin);
		if (!located.ok) {
			console.error(`dsh-keepalive: cannot resolve dsh root from bin: ${located.error}`);
			process.exit(2);
		}
		const result = restoreInstalledPatches({ dshRoot: located.root, log });
		/* v2 report: `reverted` are the restored files, `skipped` carries
		 * every non-restored copy with its reason; already-restored is
		 * benign, any other skip makes the run fail (nonzero exit). */
		for (const entry of result.reverted) {
			console.log(`dsh-keepalive: unpatch ${entry.package}: restored`);
		}
		for (const entry of result.skipped) {
			if (entry.reason === "already-restored") {
				console.log(`dsh-keepalive: unpatch ${entry.package}: already restored`);
			} else {
				console.log(`dsh-keepalive: unpatch ${entry.package}: FAILED — ${entry.reason}${entry.detail ? ` (${entry.detail})` : ""}`);
			}
		}
		process.exit(result.ok ? 0 : 1);
	}
	if (!BIN) {
		console.error("usage: node watchdog.mjs <bin-js-path> [state-file] [log-file] [web-log]");
		process.exit(2);
	}
	claim();
	applyInstalledPatches();
	/* A crashed watchdog can leave a stale repair-progress file behind, which
	 * the web host would keep serving as "repairing" — drop it on start. */
	clearRepairProgress();
	let state = readState();
	let checkInterval = Number(state.checkIntervalMs) || 5000;
	let bootWait = Number(state.bootWaitMs) || 25000;
	let silentStreak = 0;
	let gaveUp = false; // set after a failed repair: never relaunch/repair again on our own

	while (true) {
		await sleep(checkInterval);
		const eff = effectiveConfig();
		state = eff.state;
		checkInterval = eff.checkIntervalMs;
		bootWait = eff.bootWaitMs;
		if (eff.enabled !== true) {
			silentStreak = 0;
			gaveUp = false;
			writeState({ status: "watching" });
			continue;
		}
		if (gaveUp) {
			// One repair already failed: keep polling but take no action,
			// unless the web comes back on its own (e.g. started manually).
			if (await webAlive(2000)) {
				gaveUp = false;
				silentStreak = 0;
				writeState({ status: "watching", lastRestoredAt: new Date().toISOString(), repairCount: 0 });
				log("web is up again — watchdog supervision resumed");
				continue;
			}
			writeState({ status: "failed" });
			continue;
		}
		if (await webAlive(2000)) {
			silentStreak = 0;
			/* The web is UP, but a front-end plugin may have failed to load —
			 * the keepalive client reports that here, so the watchdog can
			 * repair it even though process liveness looks fine. */
			const pf = state.pluginFailure;
			if (!gaveUp && pf !== void 0 && pf !== null && typeof pf.error === "string" && pf.error.length > 0) {
				const repaired = await runPluginFailureRepair(pf);
				state = readState();
				if (repaired) {
					silentStreak = 0;
					gaveUp = false;
					continue;
				}
				gaveUp = true;
				continue;
			}
			writeState({ status: "watching" });
			continue;
		}
		silentStreak += 1;
		if (silentStreak < 2) continue; // debounce: two consecutive misses
		writeState({ status: "restoring", lastError: null });

		/* Confirm phase: a web started manually (or by a user script) takes
		 * 20-30s to bind the port, and during that window the port looks
		 * empty. Wait one full bootWait cycle before doing anything — if the
		 * web comes up on its own (its HTTP answers), stand down without
		 * killing or relaunching anything, so the watchdog never hijacks a
		 * process the user is starting in their own terminal. */
		if (await waitAlive(bootWait)) {
			silentStreak = 0;
			const fresh = portPid();
			writeState({ status: "watching", lastRestoredAt: new Date().toISOString(), repairCount: 0, ...fresh !== void 0 ? { webPid: fresh } : {} });
			log("web answered during the confirm wait — no action needed");
			continue;
		}

		// Still silent: clear a stale listener so the relaunch can own the port.
		const stale = portPid();
		if (stale !== void 0) {
			log(`port ${PORT} still held by pid ${stale} without answering — killing it`);
			killTree(stale);
			await sleep(1500);
		}

		// ---- single real web launch (also the only diagnostic source) ----
		const attemptId = new Date().toISOString().replace(/[:.]/g, "-");
		const resumeBytes = readResumeStateBytes();
		const attempt = launchWeb();
		if (attempt === void 0) {
			writeState({ status: "failed", lastError: "web log unavailable — cannot launch", repairCount: 1 });
			silentStreak = 0;
			await sleep(checkInterval * 12);
			continue;
		}
		if (await waitAlive(bootWait)) {
			/* A broken plugin tree can bind the port briefly (parallel plugin
			 * loading) and then crash the whole process. waitAlive may have
			 * seen only that brief window, so confirm the web really STAYS
			 * up: settle, then probe again. A relaunch that does not survive
			 * the settle window falls through to the repair pass instead of
			 * being misjudged as "back up". */
			await sleep(5000);
			if (await webAlive(2000)) {
				silentStreak = 0;
				const fresh = portPid();
				writeState({ status: "watching", lastRestoredAt: new Date().toISOString(), repairCount: 0, ...fresh !== void 0 ? { webPid: fresh } : {} });
				log("web is back up after relaunch");
				continue;
			}
			log("web answered during the relaunch wait but did not stay up — treating as relaunch failure");
		}

		// ---- relaunch failed: one repair pass, then exactly one final launch ----
		writeState({ status: "repairing", repairCount: 1, lastError: "web did not come up after relaunch" });
		restoreResumeStateBytes(resumeBytes);
		repairPage.start();
		setRepairPhase("detected");
		const snap = takeSnapshot(HOME, attemptId);
		log(`repair pass: snapshot taken (${Object.keys(snap.ledger).length} files)`);
		setRepairPhase("snapshot");
		const diagnostics = [
			`--- 本次真实 web 启动的完整输出 ---`,
			attemptOutput(attempt.logStart),
			`--- resume log tail (${join(DSH_HOME, "resume-state.log")}) ---`,
			tail(join(DSH_HOME, "resume-state.log"), 20),
			`--- keepalive state ---`,
			JSON.stringify(readState(), null, 2)
		].join("\n");
		const autoRepair = effectiveConfig().autoRepair;
		const modelCfg = effectiveConfig();
		const modelOpts = {
			provider: modelCfg.repairProvider ?? "",
			model: modelCfg.repairModel ?? ""
		};
		let result;
		if (autoRepair) {
			log(`repair pass: autoRepair on (provider="${modelOpts.provider}" model="${modelOpts.model}")`);
			setRepairPhase("agent-running");
			result = await repairRound(diagnostics, attemptId, modelOpts);
		} else {
			log("repair pass: autoRepair disabled — skipping repair agent");
			setRepairPhase("verifying");
			result = { ok: false, error: "autoRepair disabled" };
		}

		/* gates: changed plugin files must parse; nothing outside plugins may change */
		const { gatesPassed } = checkRepairGates(snap, result);
		if (gatesPassed) {
			log(`repair pass ok (${result.via}) — final single relaunch`);
			setRepairPhase("relaunching");
			repairPage.stop(); // release the web port before the final launch
			launchWeb();
			if (await waitAlive(bootWait)) {
				const fresh = portPid();
				writeState({ status: "watching", lastRestoredAt: new Date().toISOString(), repairCount: 0, ...fresh !== void 0 ? { webPid: fresh } : {} });
				setRepairPhase("succeeded");
				clearRepairProgress();
				log("web is back up after repair + final relaunch");
				continue;
			}
			log("repair applied but final relaunch still did not come up");
			repairPage.start(); // bring the status page back for the failure
		} else {
			log(`repair pass failed: ${result.error ?? result.out}`);
		}

		/* failed repair: roll the plugin tree back, keep resume state intact, stop. */
		const rolled = rollbackSnapshot(snap);
		log(`repair pass rolled back:\n${rolled}`);
		if (!repairPage.active()) repairPage.start();
		setRepairPhase("failed", { result: { ok: false, error: String(result.error ?? result.out ?? "").slice(0, 2000) } });
		clearRepairProgress();
		writeState({
			status: "failed",
			lastError: "web down; one repair pass failed (see keepalive.log) — no further automatic attempts",
			repairCount: 1
		});
		silentStreak = 0;
		gaveUp = true; // loop keeps polling, but never relaunch/repair again on its own
	}
}

main().catch((error) => {
	log(`watchdog fatal: ${String(error)}`);
	process.exit(1);
});
