/**
 * snapshot-rollback tests: the watchdog repair enforcement layer, tested
 * against the real lib module (previously duplicated as test-watchdog.mjs).
 * Uses a temporary HOME mirror; never touches the real ~/.dsh.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { takeSnapshot, diffSnapshot, restoreSnapshot } from "../lib/snapshot-rollback.mjs";
import { makeChecks, makeHome } from "./helpers.mjs";

const { check, done } = makeChecks("snapshot-rollback");
const base = mkdtempSync(join(tmpdir(), "ka-snap-test-"));
const HOME = makeHome(base);
const PLUGINS = join(HOME, "plugins");

try {
	/* ---- scenario 1: agent modifies a plugin file, adds a file, touches settings ---- */
	const snap1 = takeSnapshot(HOME, "t1");
	writeFileSync(join(PLUGINS, "dsh-a", "lib.js"), "export const a = 999;\n"); // changed
	mkdirSync(join(PLUGINS, "dsh-c"), { recursive: true });
	writeFileSync(join(PLUGINS, "dsh-c", "new.js"), "export const c = 3;\n"); // added
	writeFileSync(join(HOME, "settings.yaml"), "permission:\n  defaultPreset: read-only\n"); // outside
	const d1 = diffSnapshot(snap1);
	check(d1.changed.includes("dsh-a\\lib.js") && d1.changed.includes("dsh-c\\new.js"), "diff detects changed + added plugin files");
	check(d1.outsideDrift.includes("settings.yaml"), "diff detects outside drift (detection only)");
	const roll1 = restoreSnapshot(snap1);
	check(readFileSync(join(PLUGINS, "dsh-a", "lib.js"), "utf8") === "export const a = 1;\n", "rollback restores the changed plugin file");
	check(!existsSync(join(PLUGINS, "dsh-c")), "rollback removes the added plugin file and its empty dirs");
	check(readFileSync(join(HOME, "settings.yaml"), "utf8").includes("read-only"), "rollback leaves outside files untouched (drift is detection-only)");
	check(roll1.includes("restored plugins\\dsh-a\\lib.js") && roll1.includes("removed added plugins\\dsh-c\\new.js"), "rollback report names every action");

	/* ---- scenario 2: removed plugin file is restored ---- */
	const snap2 = takeSnapshot(HOME, "t2");
	rmSync(join(PLUGINS, "dsh-b", "index.mjs"), { force: true });
	const d2 = diffSnapshot(snap2);
	check(d2.removed.length === 1 && d2.removed[0] === "dsh-b\\index.mjs", "diff detects a removed plugin file");
	restoreSnapshot(snap2);
	check(existsSync(join(PLUGINS, "dsh-b", "index.mjs")), "rollback restores the removed plugin file");

	/* ---- scenario 3: untouched tree diffs empty and rolls back to the same bytes ---- */
	const snap3 = takeSnapshot(HOME, "t3");
	const d3 = diffSnapshot(snap3);
	check(d3.changed.length === 0 && d3.removed.length === 0 && d3.outsideDrift.length === 0, "untouched tree diffs clean");
	restoreSnapshot(snap3);
	check(readFileSync(join(PLUGINS, "dsh-a", "lib.js"), "utf8") === "export const a = 1;\n", "rollback on a clean tree is a byte-identical no-op");

	/* ---- scenario 4: keepalive state file is ledgered as outside drift ---- */
	writeFileSync(join(HOME, "keepalive.json"), JSON.stringify({ enabled: true, status: "watching" }));
	const snap4 = takeSnapshot(HOME, "t4");
	writeFileSync(join(HOME, "keepalive.json"), JSON.stringify({ enabled: false }));
	const d4 = diffSnapshot(snap4);
	check(d4.outsideDrift.includes("keepalive.json"), "keepalive.json drift is detected outside plugins");
} finally {
	rmSync(base, { recursive: true, force: true });
}

process.exit(done() ? 0 : 1);
