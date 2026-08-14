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
import { dirname, join } from "node:path";

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
 * Take a repair snapshot: full content copies of `<home>/plugins` only, plus
 * hash ledgers of the outside files a repair must never change (settings,
 * profiles, resume state, keepalive state — sessions/storages are ledgers
 * for drift detection only). Returns a snapshot record.
 * @param {string} home - the DSH home directory.
 * @param {string} attemptId - unique attempt id, names the snapshot dir.
 */
export function takeSnapshot(home, attemptId) {
	const dir = join(home, "keepalive-snapshots", `attempt-${attemptId}`);
	mkdirSync(dir, { recursive: true });
	const ledger = {};
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
	for (const name of ["settings.yaml", "resume-state.json", "keepalive.json"]) {
		const src = join(home, name);
		if (existsSync(src)) ledger[name] = fileHash(src);
	}
	for (const top of ["profiles"]) {
		const root = join(home, top);
		if (!existsSync(root)) continue;
		for (const rel of walkTree(root, "")) {
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

/**
 * Diff the live tree against a snapshot. Returns `changed`/`removed`/`added`
 * under plugins (rollback-capable) and `outsideDrift` for every other
 * ledgered path (detection only — never rolled back).
 */
export function diffSnapshot(snap) {
	const changed = [];
	const removed = [];
	const added = [];
	const outsideDrift = [];
	const seen = new Set();
	const home = snap.home;
	for (const rel of walkTree(join(home, "plugins"), "")) {
		const key = `plugins\\${rel}`;
		seen.add(key);
		const before = snap.ledger[key];
		const after = fileHash(join(home, "plugins", rel));
		if (before !== after) changed.push(rel);
	}
	for (const key of Object.keys(snap.ledger)) {
		const top = key.split("\\")[0];
		if (top === "plugins") {
			if (!seen.has(key)) removed.push(key.slice("plugins\\".length));
		} else {
			const now = fileHash(join(home, key));
			if (now !== snap.ledger[key]) outsideDrift.push(key);
		}
	}
	return { changed, removed, added, outsideDrift };
}

/**
 * Roll the plugins tree back to a snapshot: delete added files, restore
 * changed and removed files from the snapshot copies. Nothing outside
 * `~/.dsh/plugins` is ever restored here. Returns a report string.
 */
export function restoreSnapshot(snap) {
	const report = [];
	const home = snap.home;
	const pluginsRoot = join(home, "plugins");
	for (const rel of walkTree(pluginsRoot, "")) {
		const key = `plugins\\${rel}`;
		if (!(key in snap.ledger)) {
			try {
				rmSync(join(pluginsRoot, rel), { force: true });
				report.push(`removed added plugins\\${rel}`);
				/* tidy empty parent dirs left behind by removed files */
				let parent = dirname(join(pluginsRoot, rel));
				while (parent !== pluginsRoot && parent.startsWith(pluginsRoot)) {
					try {
						rmdirSync(parent);
					} catch {
						break; /* non-empty — stop tidying up */
					}
					parent = dirname(parent);
				}
			} catch (error) {
				report.push(`remove failed plugins\\${rel}: ${String(error)}`);
			}
		}
	}
	for (const key of Object.keys(snap.ledger)) {
		if (!key.startsWith("plugins\\")) continue;
		const rel = key.slice("plugins\\".length);
		const src = join(snap.dir, "plugins", rel);
		const dst = join(pluginsRoot, rel);
		try {
			mkdirSync(dirname(dst), { recursive: true });
			copyFileSync(src, dst);
			report.push(`restored plugins\\${rel}`);
		} catch (error) {
			report.push(`restore failed plugins\\${rel}: ${String(error)}`);
		}
	}
	return report.join("\n");
}
