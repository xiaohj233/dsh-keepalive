/**
 * uninstall tests: bin/uninstall.mjs disables keepalive state, terminates a
 * REAL detached watchdog process, restores the official files exactly, and
 * exits nonzero on any incomplete step.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureInstalledPatches } from "../lib/installed-patches.mjs";
import { makeChecks, makeDshRoot, makeHome, PRISTINE_APIPROXY, PRISTINE_SUBPROCESS } from "./helpers.mjs";

const { check, done } = makeChecks("uninstall");
const base = mkdtempSync(join(tmpdir(), "ka-uninstall-test-"));
const UNINSTALL = join(dirname(dirname(fileURLToPath(import.meta.url))), "bin", "uninstall.mjs");

function stateOf(home) {
	return JSON.parse(readFileSync(join(home, "keepalive.json"), "utf8"));
}

function pidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Spawn a real long-lived detached child to stand in for the watchdog. */
function spawnFakeWatchdog() {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
		detached: true,
		stdio: "ignore",
		windowsHide: true
	});
	child.unref();
	return child.pid;
}

function runUninstall(home, bin, extraEnv = {}) {
	const args = [UNINSTALL, "--home", home];
	if (bin !== void 0) args.push("--bin", bin);
	return spawnSync(process.execPath, args, {
		encoding: "utf8",
		env: { ...process.env, DSH_BIN: "", DSH_HOME: "", ...extraEnv },
		timeout: 60000
	});
}

const cleanup = [];
try {
	/* ================= happy path ================= */
	const home = makeHome(base);
	const fixture = makeDshRoot(base);
	writeFileSync(join(home, "keepalive.json"), JSON.stringify({ enabled: true, autoRepair: true, status: "watching", watchdogPid: 0, dshBin: fixture.bin }));
	const applied = ensureInstalledPatches({ dshRoot: fixture.root, log: () => {} });
	check(applied.ok === true, "precondition: fixtures patched");
	const fakePid = spawnFakeWatchdog();
	cleanup.push(fakePid);
	const st1 = stateOf(home);
	writeFileSync(join(home, "keepalive.json"), JSON.stringify({ ...st1, watchdogPid: fakePid }));
	check(pidAlive(fakePid), "precondition: fake watchdog alive");

	const res = runUninstall(home, fixture.bin);
	check(res.status === 0, `happy-path uninstall exits 0 (stdout: ${res.stdout.trim().split("\n")[0]})`);
	const after = stateOf(home);
	check(after.enabled === false && after.autoRepair === false && after.status === "disabled", "state disabled after uninstall");
	check(after.watchdogPid === void 0, "watchdogPid removed from state");
	check(!pidAlive(fakePid), "fake watchdog process terminated");
	check(readFileSync(join(fixture.apiDir, "lib", "index.js"), "utf8") === PRISTINE_APIPROXY, "apiproxy file byte-identical to pristine after uninstall");
	check(readFileSync(join(fixture.subDir, "lib", "index.js"), "utf8") === PRISTINE_SUBPROCESS, "subprocess file byte-identical to pristine after uninstall");

	/* ================= restore incomplete → nonzero ================= */
	const home2 = makeHome(base);
	const fixture2 = makeDshRoot(base, { apiproxyVersion: "0.1.0-rc.7" });
	writeFileSync(join(home2, "keepalive.json"), JSON.stringify({ enabled: true, status: "watching", watchdogPid: 99999999, dshBin: fixture2.bin }));
	/* apiproxy is version-mismatched, so its restore MUST fail; subprocess is
	 * pristine and reports already-restored. */
	const res2 = runUninstall(home2, fixture2.bin);
	check(res2.status !== 0, "uninstall exits nonzero when a restore step is incomplete");
	check(res2.stdout.includes(": version ("), "output names the version refusal reason");
	check(readFileSync(join(fixture2.apiDir, "lib", "index.js"), "utf8") === PRISTINE_APIPROXY, "version-mismatched file untouched");
	check(stateOf(home2).enabled === false && stateOf(home2).status === "disabled", "state still disabled even when restore fails");

	/* ================= missing bin → nonzero ================= */
	const home3 = makeHome(base);
	writeFileSync(join(home3, "keepalive.json"), JSON.stringify({ enabled: true, status: "watching" }));
	const res3 = runUninstall(home3, void 0);
	check(res3.status !== 0, "uninstall exits nonzero when the dsh bin cannot be located");
	check(res3.stdout.includes("official files NOT restored"), "output explains the incomplete step");

	/* ================= dead watchdog pid is tolerated ================= */
	const home4 = makeHome(base);
	const fixture4 = makeDshRoot(base);
	writeFileSync(join(home4, "keepalive.json"), JSON.stringify({ enabled: true, status: "watching", watchdogPid: 99999999, dshBin: fixture4.bin }));
	ensureInstalledPatches({ dshRoot: fixture4.root, log: () => {} });
	const res4 = runUninstall(home4, fixture4.bin);
	check(res4.status === 0, "uninstall succeeds when the recorded watchdog pid is already gone");
	check(stateOf(home4).status === "disabled", "state disabled in the already-dead-watchdog case");

	/* ================= --help exits 0 ================= */
	const resHelp = spawnSync(process.execPath, [UNINSTALL, "--help"], { encoding: "utf8" });
	check(resHelp.status === 0 && resHelp.stdout.includes("usage:"), "--help prints usage and exits 0");
} finally {
	for (const pid of cleanup) {
		if (pidAlive(pid)) {
			try {
				process.kill(pid);
			} catch {
				/* already gone */
			}
		}
	}
	rmSync(base, { recursive: true, force: true });
}

process.exit(done() ? 0 : 1);
