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
	check(d1.changed.includes("plugins\\dsh-a\\lib.js") && d1.changed.includes("plugins\\dsh-c\\new.js"), "diff detects changed + added plugin files");
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
	check(d2.removed.length === 1 && d2.removed[0] === "plugins\\dsh-b\\index.mjs", "diff detects a removed plugin file");
	restoreSnapshot(snap2);
	check(existsSync(join(PLUGINS, "dsh-b", "index.mjs")), "rollback restores the removed plugin file");

	/* ---- scenario 5: profile user plugins (GitHub-installed dsh-* packages) are
	 * snapshotted, diffed, and rolled back like the local plugins tree ---- */
	const profileNm = join(HOME, "profiles", "web", "node_modules");
	mkdirSync(join(profileNm, "dsh-resume", "lib"), { recursive: true });
	mkdirSync(join(profileNm, "dsh-keepalive", "lib"), { recursive: true });
	writeFileSync(join(profileNm, "dsh-resume", "package.json"), JSON.stringify({ name: "dsh-resume", version: "0.2.1" }));
	writeFileSync(join(profileNm, "dsh-resume", "lib", "index.js"), "export const ok = 1;\n");
	writeFileSync(join(profileNm, "dsh-keepalive", "lib", "index.js"), "export const keep = 1;\n");
	const snap5 = takeSnapshot(HOME, "t5");
	writeFileSync(join(profileNm, "dsh-resume", "lib", "index.js"), "export const ok = 2;\n"); // changed
	writeFileSync(join(profileNm, "dsh-resume", "lib", "extra.js"), "export const extra = 1;\n"); // added
	rmSync(join(profileNm, "dsh-keepalive", "lib", "index.js"), { force: true }); // removed
	const d5 = diffSnapshot(snap5);
	check(d5.changed.includes("profileplug\\dsh-resume\\lib\\index.js") && d5.changed.includes("profileplug\\dsh-resume\\lib\\extra.js"), "diff detects changed + added profile plugin files");
	check(d5.removed.includes("profileplug\\dsh-keepalive\\lib\\index.js"), "diff detects a removed profile plugin file");
	const roll5 = restoreSnapshot(snap5);
	check(readFileSync(join(profileNm, "dsh-resume", "lib", "index.js"), "utf8") === "export const ok = 1;\n", "rollback restores the changed profile plugin file");
	check(!existsSync(join(profileNm, "dsh-resume", "lib", "extra.js")), "rollback removes the added profile plugin file");
	check(existsSync(join(profileNm, "dsh-keepalive", "lib", "index.js")), "rollback restores the removed profile plugin file");
	/* an official @deepseek-ai package is NOT a user plugin root and must not be snapshotted */
	mkdirSync(join(profileNm, "@deepseek-ai", "dsh-session", "lib"), { recursive: true });
	writeFileSync(join(profileNm, "@deepseek-ai", "dsh-session", "lib", "index.js"), "export const official = 1;\n");
	const d5b = diffSnapshot(snap5);
	check(!d5b.changed.some((key) => key.includes("@deepseek-ai")) && !d5b.removed.some((key) => key.includes("@deepseek-ai")), "official packages are outside the user-plugin rollback scope");

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
