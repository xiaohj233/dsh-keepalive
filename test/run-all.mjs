/**
 * run-all — run every test file as a child process and aggregate the exit
 * codes, so `npm test` works the same on Windows cmd and POSIX shells.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tests = [
	"test/llm-config.test.mjs",
	"test/installed-patches.test.mjs",
	"test/snapshot-rollback.test.mjs",
	"test/repair-page.test.mjs",
	"test/uninstall.test.mjs",
	"test/watchdog-unpatch.test.mjs"
];

let failed = false;
for (const rel of tests) {
	console.log(`\n=== ${rel} ===`);
	const res = spawnSync(process.execPath, [join(root, rel)], {
		encoding: "utf8",
		timeout: 180000,
		stdio: ["ignore", "inherit", "inherit"]
	});
	if (res.status !== 0) {
		failed = true;
		console.log(`=== ${rel} FAILED (exit ${res.status}) ===`);
	}
}
console.log(failed ? "\nTEST RUN FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
