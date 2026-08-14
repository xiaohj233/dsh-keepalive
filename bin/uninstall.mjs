#!/usr/bin/env node
/**
 * dsh-keepalive-uninstall — the explicit uninstall command.
 *
 * Uninstalling dsh-keepalive is a deliberate act, so it is an explicit
 * command — NOT a side effect of the plugin fiber being disposed. Ordinary
 * web shutdowns, plugin reloads, and profile switches happen constantly and
 * must never strip the installed-package patches (the settings card would
 * break on the next boot, and the watchdog keeps using them while running).
 *
 * What this command does, in order:
 *   1. Disable keepalive state — writes `keepalive.json` with
 *      `enabled: false`, `autoRepair: false`, `status: "disabled"` so no
 *      surviving watchdog can keep acting on the old state.
 *   2. Stop the detached watchdog — terminates the pid recorded in
 *      `keepalive.json` (only that process, never its web child) and waits
 *      until it is actually gone.
 *   3. Restore the official files — reverts the exact installed-package
 *      patches (settings-namespace exposure + windowsHide), version-guarded
 *      and atomic (see lib/installed-patches.mjs).
 *   4. Exits NONZERO when any step is incomplete, with the reasons printed.
 *
 * Usage:
 *   node bin/uninstall.mjs [--home <DSH_HOME>] [--bin <dsh-bin.js>] [--help]
 *
 * DSH_HOME defaults to $DSH_HOME then `~/.dsh`. The dsh bin.js is taken from
 * `--bin`, then $DSH_BIN, then the `dshBin` recorded in keepalive.json by
 * the host plugin. When a step cannot be completed (for example the patched
 * region no longer matches the canonical layout after an upstream change),
 * the command fails loudly and tells you how to recover (reinstall the
 * official package) instead of corrupting the file.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { restoreInstalledPatches, resolveDshRootFromBin } from "../lib/installed-patches.mjs";

const args = process.argv.slice(2);

function usage() {
	console.log(
		[
			"usage: node bin/uninstall.mjs [--home <DSH_HOME>] [--bin <dsh-bin.js>] [--help]",
			"",
			"Disables keepalive state, stops the detached watchdog, and restores the",
			"official files patched by dsh-keepalive (apiproxy settings-namespace",
			"exposure, subprocess windowsHide). Exits nonzero when anything is",
			"incomplete."
		].join("\n")
	);
}

if (args.includes("--help") || args.includes("-h")) {
	usage();
	process.exit(0);
}

function argValue(flag) {
	const at = args.indexOf(flag);
	if (at === -1 || at + 1 >= args.length) return void 0;
	return args[at + 1];
}

const HOME = argValue("--home") ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
const STATE_FILE = join(HOME, "keepalive.json");

let stepFailed = false;

function report(ok, line) {
	console.log(`${ok ? "ok" : "FAILED"} — ${line}`);
	if (!ok) stepFailed = true;
}

function readState() {
	try {
		return JSON.parse(readFileSync(STATE_FILE, "utf8"));
	} catch {
		return {};
	}
}

function writeState(patch) {
	const merged = { ...readState(), ...patch, updatedAt: Date.now() };
	const tmp = STATE_FILE + ".uninstall-tmp";
	writeFileSync(tmp, JSON.stringify(merged, null, 2));
	renameSync(tmp, STATE_FILE);
}

function pidAlive(pid) {
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Terminate exactly the watchdog process (never its detached web child)
 * and wait up to `timeoutMs` for it to actually exit. */
async function stopWatchdog(pid) {
	if (!pidAlive(pid)) {
		report(true, `watchdog pid ${pid ?? "(none)"} is not running`);
		return;
	}
	try {
		process.kill(pid); /* SIGTERM on POSIX; TerminateProcess on Windows */
	} catch (error) {
		report(false, `could not signal watchdog pid ${pid}: ${String(error)}`);
		return;
	}
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (!pidAlive(pid)) {
			report(true, `watchdog pid ${pid} terminated`);
			return;
		}
		await sleep(150);
	}
	report(false, `watchdog pid ${pid} is still alive after termination — kill it manually (taskkill /PID ${pid} /F)`);
}

async function main() {
	console.log(`dsh-keepalive uninstall — DSH_HOME=${HOME}`);

	/* 1. capture the current state BEFORE rewriting it */
	const state = readState();
	const watchdogPid = typeof state.watchdogPid === "number" ? state.watchdogPid : void 0;
	const stateBin = typeof state.dshBin === "string" ? state.dshBin : void 0;

	/* 2. disable keepalive state first: even if the watchdog survives this
	 * command for a moment, it sees enabled=false and takes no action. */
	try {
		writeState({ enabled: false, autoRepair: false, status: "disabled", watchdogPid: void 0 });
		report(true, `keepalive state disabled (${STATE_FILE})`);
	} catch (error) {
		report(false, `could not disable keepalive state: ${String(error)}`);
	}

	/* 3. stop the detached watchdog if alive */
	await stopWatchdog(watchdogPid);
	/* A watchdog that died between our disable-write and the kill could have
	 * rewritten the state file; re-assert the disabled state so the tombstone
	 * is final. */
	try {
		writeState({ enabled: false, autoRepair: false, status: "disabled", watchdogPid: void 0 });
	} catch {
		/* already reported once; nothing more to do */
	}

	/* 4. restore the official files */
	const bin = argValue("--bin") ?? process.env.DSH_BIN ?? stateBin;
	if (typeof bin !== "string" || bin.length === 0) {
		report(false, "cannot locate the dsh bin.js — pass --bin <dsh-bin.js> or run uninstall while the host plugin has recorded dshBin in keepalive.json; official files NOT restored");
	} else {
		const located = resolveDshRootFromBin(bin);
		if (!located.ok) {
			report(false, `cannot resolve dsh root from bin (${bin}): ${located.error}`);
		} else {
			const result = restoreInstalledPatches({
				dshRoot: located.root,
				log: (line) => console.log(`  ${line}`)
			});
			/* v2 report: `reverted` are the restored files, `skipped` carries
			 * every non-restored copy with its reason; already-restored is
			 * benign, any other skip is a failure. */
			for (const entry of result.reverted) {
				console.log(`ok — ${entry.package}: restored`);
			}
			for (const entry of result.skipped) {
				if (entry.reason === "already-restored") {
					console.log(`ok — ${entry.package}: already restored`);
				} else {
					report(false, `${entry.package}: ${entry.reason}${entry.detail ? ` (${entry.detail})` : ""}`);
				}
			}
		}
	}

	if (stepFailed) {
		console.log("");
		console.log("dsh-keepalive uninstall INCOMPLETE — resolve the FAILED steps above and rerun.");
		console.log("When a restore reports an unrecognized patched region, reinstall the official");
		console.log("package (or DSH itself) to bring the file back to its pristine content.");
		process.exit(1);
	}
	console.log("");
	console.log("dsh-keepalive uninstall complete: keepalive disabled, watchdog stopped, official files restored.");
	process.exit(0);
}

main().catch((error) => {
	console.error(`dsh-keepalive uninstall error: ${error instanceof Error ? error.stack : String(error)}`);
	process.exit(1);
});
