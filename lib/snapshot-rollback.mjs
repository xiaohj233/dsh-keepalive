/**
 * snapshot-rollback — the enforcement layer that keeps repair agents from
 * making things worse: a full content snapshot of `~/.dsh/plugins` plus hash
 * ledgers of everything outside it, a diff, and a rollback that restores the
 * plugin tree exactly. Independent of dsh itself (Node built-ins only), so
 * the watchdog can use it when dsh cannot boot.
 *
 * Boundary semantics: the snapshot/rollback layer is the enforcement
 * mechanism. The repair agent runs under a workspace-write permission preset,
 * which is a *convenience scope*, not a security isolation boundary — the
 * ledger gates (outside drift, syntax check, config dump) plus the rollback
 * are what bound the damage a repair can do.
 */

import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmdirSync,
	rmSync
} from "node:fs";
import { basename, dirname, join } from "node:path";

/** Top-level HOME entries excluded from the plugins walk (snapshots and logs
 * are runtime artifacts, not plugin content). */
const EXCLUDE_NAMES = new Set(["keepalive-snapshots", "keepalive.log", "keepalive-web.log"]);

/** Relative paths of every file under `root` (directories recursed). */
export function walkTree(root, rel) {
	const out = [];
	const full = join(root, rel);
	let entries;
	try {
		entries = readdirSync(full, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const ent of entries) {
		const childRel = rel === "" ? ent.name : join(rel, ent.name);
		if (rel === "" && EXCLUDE_NAMES.has(ent.name)) continue;
		if (ent.isDirectory()) {
			out.push(...walkTree(root, childRel));
		} else if (ent.isFile()) {
			out.push(childRel);
		}
	}
	return out;
}

/** sha256 of a file, or null when unreadable. */
export function fileHash(abs) {
	try {
		return createHash("sha256").update(readFileSync(abs)).digest("hex");
	} catch {
		return null;
	}
}

/**
 * Take a repair snapshot: full content copies of `<home>/plugins` and of the
 * user plugin packages under `<home>/profiles/web/node_modules/dsh-*` (the
 * GitHub-installed plugins the web profile actually loads), plus hash ledgers
 * of the outside files a repair must never change (settings, profiles,
 * resume state, keepalive state). Returns a snapshot record.
 * @param {string} home - the DSH home directory.
 * @param {string} attemptId - unique attempt id, names the snapshot dir.
 */
/** User plugin package directories (dsh-* under the web profile node_modules). */
export function userPluginRoots(home) {
	const nm = join(home, "profiles", "web", "node_modules");
	const out = [];
	let entries;
	try {
		entries = readdirSync(nm, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const ent of entries) {
		if (ent.isDirectory() && ent.name.startsWith("dsh-")) out.push(join(nm, ent.name));
	}
	return out;
}

export function takeSnapshot(home, attemptId) {
	const dir = join(home, "keepalive-snapshots", `attempt-${attemptId}`);
	mkdirSync(dir, { recursive: true });
	const ledger = {};
	/* plugins: full content copies (rollback-capable) */
	for (const rel of walkTree(join(home, "plugins"), "")) {
		const src = join(home, "plugins", rel);
		const dst = join(dir, "plugins", rel);
		try {
			mkdirSync(dirname(dst), { recursive: true });
			copyFileSync(src, dst);
			ledger[`plugins\\${rel}`] = fileHash(src);
		} catch (error) {
			ledger[`plugins\\${rel}`] = null;
		}
	}
	/* profile user plugins (dsh-* packages): full content copies (rollback-capable) */
	for (const pkgDir of userPluginRoots(home)) {
		const pkgName = basename(pkgDir);
		for (const rel of walkTree(pkgDir, "")) {
			const src = join(pkgDir, rel);
			const dst = join(dir, "profile-plugins", pkgName, rel);
			try {
				mkdirSync(dirname(dst), { recursive: true });
				copyFileSync(src, dst);
				ledger[`profileplug\\${pkgName}\\${rel}`] = fileHash(src);
			} catch (error) {
				ledger[`profileplug\\${pkgName}\\${rel}`] = null;
			}
		}
	}
	for (const name of ["settings.yaml", "resume-state.json", "keepalive.json"]) {
		const src = join(home, name);
		if (existsSync(src)) ledger[name] = fileHash(src);
	}
	for (const top of ["profiles"]) {
		const root = join(home, top);
		if (!existsSync(root)) continue;
		for (const rel of walkTree(root, "")) {
			/* node_modules is skipped in the drift ledger: dsh-* packages are
			 * content-snapshotted above; @deepseek-ai and friends must never
			 * change, and a full node_modules ledger would be huge/slow. */
			if (rel.startsWith("web\\node_modules")) continue;
			ledger[`${top}\\${rel}`] = fileHash(join(root, rel));
		}
	}
	for (const top of ["sessions", "storages"]) {
		const root = join(home, top);
		if (!existsSync(root)) continue;
		for (const rel of walkTree(root, "")) {
			ledger[`${top}\\${rel}`] = fileHash(join(root, rel));
		}
	}
	return { attemptId, home, dir, ledger };
}

/** Is this ledger key a rollback-capable path (plugins or profile user plugins)? */
function isRollbackKey(key) {
	return key.startsWith("plugins\\") || key.startsWith("profileplug\\");
}

/**
 * Diff the live tree against a snapshot. Returns `changed`/`removed`/`added`
 * under plugins and profile user plugins (rollback-capable) and
 * `outsideDrift` for every other ledgered path (detection only — never
 * rolled back).
 */
export function diffSnapshot(snap) {
	const changed = [];
	const removed = [];
	const added = [];
	const outsideDrift = [];
	const seen = new Set();
	const home = snap.home;
	const scanRoots = [["plugins", join(home, "plugins")]];
	for (const pkgDir of userPluginRoots(home)) {
		scanRoots.push([`profileplug\\${basename(pkgDir)}`, pkgDir]);
	}
	for (const [prefix, root] of scanRoots) {
		for (const rel of walkTree(root, "")) {
			const key = `${prefix}\\${rel}`;
			seen.add(key);
			const before = snap.ledger[key];
			const after = fileHash(join(root, rel));
			if (before !== after) changed.push(key);
		}
	}
	for (const key of Object.keys(snap.ledger)) {
		if (isRollbackKey(key)) {
			if (!seen.has(key)) removed.push(key);
		} else {
			const now = fileHash(join(home, key));
			if (now !== snap.ledger[key]) outsideDrift.push(key);
		}
	}
	return { changed, removed, added, outsideDrift };
}

/**
 * Roll the plugin trees (plugins + profile user plugins) back to a snapshot:
 * delete added files, restore changed and removed files from the snapshot
 * copies. Nothing outside those two trees is ever restored here.
 * Returns a report string.
 */
export function restoreSnapshot(snap) {
	const report = [];
	const home = snap.home;
	const roots = [["plugins", join(home, "plugins")]];
	for (const pkgDir of userPluginRoots(home)) {
		roots.push([`profileplug\\${basename(pkgDir)}`, pkgDir]);
	}
	for (const [prefix, root] of roots) {
		for (const rel of walkTree(root, "")) {
			const key = `${prefix}\\${rel}`;
			if (!(key in snap.ledger)) {
				try {
					rmSync(join(root, rel), { force: true });
					report.push(`removed added ${key}`);
					let parent = dirname(join(root, rel));
					while (parent !== root && parent.startsWith(root)) {
						try {
							rmdirSync(parent);
						} catch {
							break; /* non-empty — stop tidying up */
						}
						parent = dirname(parent);
					}
				} catch (error) {
					report.push(`remove failed ${key}: ${String(error)}`);
				}
			}
		}
	}
	for (const key of Object.keys(snap.ledger)) {
		if (!isRollbackKey(key)) continue;
		const prefix = key.startsWith("plugins\\") ? "plugins" : "profileplug";
		const rest = key.slice(prefix.length + 1);
		let dst;
		let src;
		if (prefix === "plugins") {
			dst = join(home, "plugins", rest);
			src = join(snap.dir, "plugins", rest);
		} else {
			const [pkgName, ...relParts] = rest.split("\\");
			dst = join(home, "profiles", "web", "node_modules", pkgName, ...relParts);
			src = join(snap.dir, "profile-plugins", pkgName, ...relParts);
		}
		try {
			mkdirSync(dirname(dst), { recursive: true });
			copyFileSync(src, dst);
			report.push(`restored ${key}`);
		} catch (error) {
			report.push(`restore failed ${key}: ${String(error)}`);
		}
	}
	return report.join("\n");
}
