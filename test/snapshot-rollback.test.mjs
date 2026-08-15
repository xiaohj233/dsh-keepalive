/**
 * snapshot-rollback tests: the watchdog repair enforcement layer, tested
 * against the real lib module (previously duplicated as test-watchdog.mjs).
 * Uses a temporary HOME mirror; never touches the real ~/.dsh.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

	/* ---- scenario 6: link-target node_modules junctions are the sanctioned
	 * repair action; deleting or retargeting existing entries is drift ---- */
	const dev = join(base, "dev", "injector");
	const devNm = join(dev, "node_modules");
	mkdirSync(join(devNm, "existing-pkg"), { recursive: true });
	mkdirSync(join(dev, "lib"), { recursive: true });
	const official = join(base, "official", "dsh-tools");
	mkdirSync(official, { recursive: true });
	writeFileSync(join(HOME, "profiles", "web", "package.json"), JSON.stringify({
		name: "dsh-profile-web",
		dependencies: { "@dsh-external/dsh-super-injector": "link:" + dev }
	}));
	const snap6 = takeSnapshot(HOME, "t6");
	mkdirSync(join(devNm, "@deepseek-ai"), { recursive: true });
	symlinkSync(official, join(devNm, "@deepseek-ai", "dsh-tools"), "junction");
	const d6 = diffSnapshot(snap6);
	check(d6.linkAdded.some((key) => key.endsWith("dsh-tools")), "adding a dependency junction in a link target is the sanctioned repair action");
	check(d6.linkDrift.length === 0 && d6.outsideDrift.length === 0, "sanctioned junctions are neither link drift nor outside drift");
	rmSync(join(devNm, "existing-pkg"), { recursive: true, force: true });
	const d6b = diffSnapshot(snap6);
	check(d6b.linkDrift.some((key) => key.includes("existing-pkg")), "deleting an existing link-target entry is drift");
	mkdirSync(join(devNm, "existing-pkg"), { recursive: true });
	const roll6 = restoreSnapshot(snap6);
	check(!existsSync(join(devNm, "@deepseek-ai", "dsh-tools")), "rollback removes the added link junction");
	check(existsSync(join(devNm, "existing-pkg")), "rollback keeps pre-existing link-target entries");

	/* ---- scenario 7: watchdog-managed dynamic keepalive fields are not
	 * repair drift; a changed static field still is ---- */
	const kstate = { enabled: true, version: 1, watchdogPid: 1, status: "watching", updatedAt: 1, lastError: null, webPid: 1, lastRestoredAt: "a", repairCount: 0, autoRepair: true, repairProvider: "bendi", repairModel: "m", checkIntervalMs: 5000, bootWaitMs: 25000, dshBin: "bin" };
	writeFileSync(join(HOME, "keepalive.json"), JSON.stringify(kstate));
	const snap7 = takeSnapshot(HOME, "t7");
	writeFileSync(join(HOME, "keepalive.json"), JSON.stringify({ ...kstate, status: "failed", updatedAt: 999, webPid: 2, lastError: "changed", lastRestoredAt: "b", repairCount: 1, watchdogPid: 2 }));
	const d7 = diffSnapshot(snap7);
	check(!d7.outsideDrift.includes("keepalive.json"), "watchdog-managed dynamic keepalive fields are not repair drift");
	writeFileSync(join(HOME, "keepalive.json"), JSON.stringify({ ...kstate, enabled: false }));
	const d7b = diffSnapshot(snap7);
	check(d7b.outsideDrift.includes("keepalive.json"), "a changed keepalive static field is still drift");

	/* ---- scenario 8: link-target root source edits are snapshot-tracked
	 * and rollback-capable (the sanctioned repair action since v0.2.8) ---- */
	writeFileSync(join(dev, "client.js"), "export const c = 1;");
	writeFileSync(join(dev, "index.js"), "export const ok = 1;");
	const snap8 = takeSnapshot(HOME, "t8");
	writeFileSync(join(dev, "client.js"), "let raf = 0; export const c = 2;"); // sanctioned edit
	writeFileSync(join(dev, "extra.js"), "export const e = 1;"); // sanctioned add
	const d8 = diffSnapshot(snap8);
	check(d8.changed.includes("linkroot\\0\\client.js") && d8.changed.includes("linkroot\\0\\extra.js"), "link-target source edits are tracked as sanctioned changes");
	check(d8.outsideDrift.length === 0 && d8.linkDrift.length === 0, "sanctioned link-target source edits are not drift");
	rmSync(join(dev, "index.js"), { force: true }); // deletion is rolled back too
	const roll8 = restoreSnapshot(snap8);
	check(readFileSync(join(dev, "client.js"), "utf8") === "export const c = 1;", "rollback restores the edited link-target source");
	check(!existsSync(join(dev, "extra.js")), "rollback removes the added link-target file");
	check(readFileSync(join(dev, "index.js"), "utf8") === "export const ok = 1;", "rollback restores the deleted link-target file");
} finally {
	rmSync(base, { recursive: true, force: true });
}

process.exit(done() ? 0 : 1);
