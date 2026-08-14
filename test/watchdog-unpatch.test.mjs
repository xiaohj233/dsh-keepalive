/* End-to-end checks of watchdog modes against fixture dsh roots:
 *  - normal startup applies the installed-package patches and claims state
 *    WITHOUT relying on anything else being run first;
 *  - --unpatch uses the fixed argument parsing (bin is argv[3], never the
 *    flag itself) and restores exactly;
 *  - the old broken bare `--unpatch` invocation fails with a usage error
 *    instead of unpatching a garbage `.\node_modules`. */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureInstalledPatches } from "../lib/installed-patches.mjs";
import { makeDshRoot, PRISTINE_APIPROXY, PRISTINE_SUBPROCESS } from "./helpers.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const WATCHDOG = join(root, "watchdog.mjs");

const base = mkdtempSync(join(tmpdir(), "ka-wd-test-"));
let failures = 0;
const check = (cond, name) => {
	console.log(`${cond ? "PASS" : "FAIL"} watchdog: ${name}`);
	if (!cond) failures += 1;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function pidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
try {
	/* ---- startup applies patches + claims state ---- */
	const home = join(base, "home");
	mkdirSync(home, { recursive: true });
	const fixture = makeDshRoot(base);
	const stateFile = join(home, "keepalive.json");
	const logFile = join(home, "keepalive.log");
	const webLog = join(home, "keepalive-web.log");
	writeFileSync(join(home, "settings.yaml"), "permission:\n  defaultPreset: danger-full-access\n");
	const watchdog = spawn(process.execPath, [WATCHDOG, fixture.bin, stateFile, logFile, webLog], {
		env: { ...process.env, DSH_HOME: home },
		stdio: "ignore",
		windowsHide: true
	});
	try {
		let claimed = false;
		let apiPatched = false;
		let subprocessPatched = false;
		for (let i = 0; i < 40; i += 1) {
			await sleep(250);
			claimed = existsSync(stateFile);
			apiPatched = readFileSync(join(fixture.apiDir, "lib", "index.js"), "utf8").includes('"keepalive", // dsh-keepalive');
			subprocessPatched = readFileSync(join(fixture.subDir, "lib", "index.js"), "utf8").includes("/* dsh-keepalive patch:");
			if (claimed && apiPatched && subprocessPatched) break;
		}
		check(claimed, "watchdog startup writes the state file (claim)");
		check(apiPatched, "watchdog startup applied the apiproxy patch by itself");
		check(subprocessPatched, "watchdog startup applied the windowsHide patch by itself");
		check(JSON.parse(readFileSync(stateFile, "utf8")).watchdogPid === watchdog.pid, "state claims the watchdog pid");
	} finally {
		if (pidAlive(watchdog.pid)) {
			try {
				process.kill(watchdog.pid);
			} catch {
				/* already gone */
			}
		}
	}
	check(!pidAlive(watchdog.pid), "watchdog process stopped after kill");

	/* ---- --unpatch: fixed argument parsing + exact restore ---- */
	const applied = ensureInstalledPatches({ dshRoot: fixture.root, log: () => {} });
	check(applied.ok, "precondition: fixtures patched");

	const ok = spawnSync(process.execPath, [WATCHDOG, "--unpatch", fixture.bin], { encoding: "utf8", timeout: 60000 });
	check(ok.status === 0, `--unpatch <bin> exits 0 (${ok.stdout.trim().split("\n")[0]})`);
	check(readFileSync(join(fixture.apiDir, "lib", "index.js"), "utf8") === PRISTINE_APIPROXY, "apiproxy pristine after --unpatch");
	check(readFileSync(join(fixture.subDir, "lib", "index.js"), "utf8") === PRISTINE_SUBPROCESS, "subprocess pristine after --unpatch");

	const again = spawnSync(process.execPath, [WATCHDOG, "--unpatch", fixture.bin], { encoding: "utf8", timeout: 60000 });
	check(again.status === 0 && again.stdout.includes("already restored"), "second --unpatch is a no-op");

	/* the old broken invocation: --unpatch with NO bin (argv[2] was treated
	 * as the bin in the old code, unpatching a garbage .\node_modules) */
	const broken = spawnSync(process.execPath, [WATCHDOG, "--unpatch"], { encoding: "utf8", timeout: 60000 });
	check(broken.status === 2 && (broken.stdout + broken.stderr).includes("usage"), "bare --unpatch (old buggy invocation) exits 2 with usage");
} finally {
	rmSync(base, { recursive: true, force: true });
}
process.exit(failures === 0 ? 0 : 1);
