#!/usr/bin/env node
/**
 * dsh-keepalive — detached fallback restarter for manual web restarts.
 *
 * The web process schedules a manual restart by spawning this helper
 * detached (spec JSON in argv[2]) and then exiting. Normally the keep-alive
 * watchdog notices the exit within one check interval and relaunches the web
 * with the same binary and arguments; this helper waits comfortably past that
 * window and only launches the web itself when no watchdog is alive at that
 * point, so a manual restart also works with keep-alive disabled.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

let spec = {};
try {
	spec = JSON.parse(process.argv[2] ?? "{}");
} catch {
	/* malformed spec: fall through with empty spec, the guard below exits */
}
const { bin, args, stateFile, intervalMs } = spec;
const delayMs = Math.max(10000, (Number(intervalMs) || 5000) + 5000);

function readState() {
	try {
		return JSON.parse(readFileSync(stateFile, "utf8"));
	} catch {
		return {};
	}
}

/** The watchdog counts as alive when its recorded pid answers kill(pid, 0). */
function watchdogAlive() {
	const pid = readState().watchdogPid;
	if (typeof pid !== "number" || !Number.isSafeInteger(pid)) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

setTimeout(() => {
	if (watchdogAlive()) process.exit(0); // watchdog already relaunched the web
	if (typeof bin !== "string" || bin.length === 0 || !Array.isArray(args) || args.length === 0) process.exit(1);
	try {
		const child = spawn(process.execPath, args, {
			detached: true,
			stdio: "ignore",
			windowsHide: true
		});
		child.unref();
	} catch {
		/* best effort: the operator can start the web manually */
	}
	process.exit(0);
}, delayMs);
