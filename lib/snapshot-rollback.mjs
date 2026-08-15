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
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	readdirSync,
	rmdirSync,
	rmSync
} from "node:fs";
import { basename, dirname, join } from "node:path";

/** Top-level HOME entries excluded from the plugins walk (snapshots and logs
 * are runtime artifacts, not plugin content). */
const EXCLUDE_NAMES = new Set(["keepalive-snapshots", "keepalive.log", "keepalive-web.log"]);

/** keepalive.json fields the watchdog itself manages every poll/event. A
 * repair must never be failed just because the watchdog (or the framework)
 * refreshed these while the repair ran; the static fields below are the ones
 * a repair would have to touch to tamper with keepalive behaviour. */
const KEEPALIVE_DYNAMIC = new Set([
	"status", "updatedAt", "webPid", "lastError", "repairCount",
	"lastRestoredAt", "watchdogPid", "pluginFailure"
]);
const KEEPALIVE_STATIC_KEY = "keepalive.json";

/** Resolve every dev-checkout dependency target from the web profile
 * package.json (`link:` and directory `file:` specs) — the repair agent is
 * allowed to ADD dependency junctions under these node_modules dirs. */
export function linkTargetNodeModules(home) {
	return linkTargetDirs(home).map((dir) => join(dir, "node_modules"));
}

/** Root directories of every dev-checkout dependency target from the web
 * profile package.json. Since v0.2.8 the repair agent may also make minimal
 * source edits inside these roots (snapshot-tracked, rollback-capable);
 * deletion is forbidden by the prompt and rolled back if it happens. */
export function linkTargetDirs(home) {
	const out = [];
	let pkg;
	try {
		pkg = JSON.parse(readFileSync(join(home, "profiles", "web", "package.json"), "utf8"));
	} catch {
		return out;
	}
	const deps = { ...(pkg.dependencies || {}) };
	for (const spec of Object.values(deps)) {
		if (typeof spec !== "string") continue;
		const m = /^link:(.+)$/.exec(spec) || /^file:(.+)$/.exec(spec);
		if (!m) continue;
		let target = m[1];
		try {
			if (!lstatSync(target).isDirectory()) continue;
		} catch {
			continue;
		}
		/* The web profile links the official @deepseek-ai/* packages with the
		 * link: protocol too (they resolve into the dsh install tree). Those
		 * are NOT user dev checkouts: they must never be source-editable or
		 * content-snapshotted, and they would break the common-parent
		 * workspace root (install tree vs user code share only the drive). */
		try {
			const pkgName = JSON.parse(readFileSync(join(target, "package.json"), "utf8")).name;
			if (typeof pkgName === "string" && pkgName.startsWith("@deepseek-ai/")) continue;
		} catch {
			/* no package.json — keep the entry as a dev checkout */
		}
		out.push(target);
	}
	return out;
}

/** target of a top-level node_modules entry (junction/symlink target, or
 * "dir" for a real directory). */
function linkTargetOf(p) {
	try {
		if (lstatSync(p).isSymbolicLink()) return readlinkSync(p);
	} catch {
		/* unreadable entry — treat as drift-prone "dir" */
	}
	return "dir";
}

/** Top-level entries of a node_modules dir: "name" or "@scope\\child",
 * mapped to their target. Never recurses into package contents. */
export function scanTopEntries(nm) {
	const map = new Map();
	let entries;
	try {
		entries = readdirSync(nm, { withFileTypes: true });
	} catch {
		return map;
	}
	for (const ent of entries) {
		/* junction/symlink entries report isSymbolicLink() (not isDirectory())
		 * on Windows — accept both so dev-checkout dependency junctions are
		 * tracked. */
		if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
		if (ent.name.startsWith("@")) {
			let sub;
			try {
				sub = readdirSync(join(nm, ent.name), { withFileTypes: true });
			} catch {
				continue;
			}
			for (const s of sub) {
				if (!s.isDirectory() && !s.isSymbolicLink()) continue;
				map.set(`${ent.name}\\${s.name}`, linkTargetOf(join(nm, ent.name, s.name)));
			}
		} else {
			map.set(ent.name, linkTargetOf(join(nm, ent.name)));
		}
	}
	return map;
}

/** hash of the keepalive.json static (non-watchdog-managed) field subset. */
function keepaliveStaticHash(p) {
	try {
		const obj = JSON.parse(readFileSync(p, "utf8"));
		const stat = {};
		for (const [k, v] of Object.entries(obj)) {
			if (!KEEPALIVE_DYNAMIC.has(k)) stat[k] = v;
		}
		return "kstatic:" + createHash("sha256").update(JSON.stringify(stat)).digest("hex");
	} catch {
		return fileHash(p);
	}
}

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

export function takeSnapshot(home, attemptId, options = {}) {
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
	for (const name of ["settings.yaml", "resume-state.json", KEEPALIVE_STATIC_KEY]) {
		/* With the web UP (degraded repair), dsh-resume rewrites
		 * resume-state.json on its own cycle and the host may rewrite
		 * settings.yaml — neither is drift the repair caused. */
		if (options.skipLiveDirs && (name === "resume-state.json" || name === "settings.yaml")) continue;
		const src = join(home, name);
		if (existsSync(src)) {
			ledger[name] = name === KEEPALIVE_STATIC_KEY ? keepaliveStaticHash(src) : fileHash(src);
		}
	}
	/* link-target node_modules (link:/file: dir dev checkouts): top-level
	 * entry ledger. Repair agents may ADD junction entries here to resolve
	 * dependencies for dev-checkout links; removing or retargeting existing
	 * entries is out-of-bounds drift. */
	const linkDirs = linkTargetDirs(home);
	const linkNms = linkDirs.map((dir) => join(dir, "node_modules"));
	for (let i = 0; i < linkNms.length; i++) {
		for (const [rel, target] of scanTopEntries(linkNms[i])) {
			ledger[`linknm\\${i}\\${rel}`] = target;
		}
	}
	/* link-target roots: full content copies (rollback-capable) since v0.2.8,
	 * so the repair agent can make minimal source edits inside the dev
	 * checkout that owns the failing plugin. walkTree never follows junction
	 * entries, so the node_modules dirs above are not copied here. */
	for (let i = 0; i < linkDirs.length; i++) {
		const root = linkDirs[i];
		for (const rel of walkTree(root, "")) {
			const src = join(root, rel);
			const dst = join(dir, "linkroots", String(i), rel);
			try {
				mkdirSync(dirname(dst), { recursive: true });
				copyFileSync(src, dst);
				ledger[`linkroot\\${i}\\${rel}`] = fileHash(src);
			} catch (error) {
				ledger[`linkroot\\${i}\\${rel}`] = null;
			}
		}
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
	/* sessions/storages are live-written by a RUNNING web process. The
	 * launch-failure repair (web down) ledger-checks them; the degraded
	 * plugin-failure repair (web UP) must skip them or the web's own writes
	 * would always look like out-of-bounds drift. */
	if (!options.skipLiveDirs) {
		for (const top of ["sessions", "storages"]) {
			const root = join(home, top);
			if (!existsSync(root)) continue;
			for (const rel of walkTree(root, "")) {
				ledger[`${top}\\${rel}`] = fileHash(join(root, rel));
			}
		}
	}
	return { attemptId, home, dir, ledger, linkNms, linkRoots: linkDirs };
}

/** Is this ledger key a rollback-capable path (plugins or profile user plugins)? */
function isRollbackKey(key) {
	return key.startsWith("plugins\\") || key.startsWith("profileplug\\") || key.startsWith("linkroot\\");
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
	const linkAdded = [];
	const linkDrift = [];
	const seen = new Set();
	const home = snap.home;
	const scanRoots = [["plugins", join(home, "plugins")]];
	for (const pkgDir of userPluginRoots(home)) {
		scanRoots.push([`profileplug\\${basename(pkgDir)}`, pkgDir]);
	}
	const linkRoots = snap.linkRoots ?? [];
	for (let i = 0; i < linkRoots.length; i++) {
		scanRoots.push([`linkroot\\${i}`, linkRoots[i]]);
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
		} else if (key.startsWith("linknm\\")) {
			/* handled in the link-target pass below */
		} else {
			const abs = join(home, key);
			const now = key === KEEPALIVE_STATIC_KEY ? keepaliveStaticHash(abs) : fileHash(abs);
			if (now !== snap.ledger[key]) outsideDrift.push(key);
		}
	}
	/* link-target node_modules: additions are the sanctioned repair action;
	 * deletions or retargeting of existing entries are out-of-bounds. */
	const linkNms = snap.linkNms ?? [];
	const linkEntries = linkNms.map((nm) => scanTopEntries(nm));
	for (let i = 0; i < linkNms.length; i++) {
		for (const [rel, target] of linkEntries[i]) {
			const key = `linknm\\${i}\\${rel}`;
			const before = snap.ledger[key];
			if (before === void 0) linkAdded.push(key);
			else if (before !== target) linkDrift.push(key);
		}
		for (const key of Object.keys(snap.ledger)) {
			if (!key.startsWith(`linknm\\${i}\\`)) continue;
			const rel = key.slice(`linknm\\${i}\\`.length);
			if (!linkEntries[i].has(rel)) linkDrift.push(key);
		}
	}
	return { changed, removed, added, outsideDrift, linkAdded, linkDrift };
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
	/* remove added junction entries in link-target node_modules (rollback of
	 * the sanctioned repair action); existing entries are never touched. */
	const linkNms = snap.linkNms ?? [];
	for (let i = 0; i < linkNms.length; i++) {
		const nm = linkNms[i];
		for (const [rel] of scanTopEntries(nm)) {
			const key = `linknm\\${i}\\${rel}`;
			if (key in snap.ledger) continue;
			const abs = join(nm, ...rel.split("\\"));
			try {
				rmSync(abs, { force: true });
				report.push(`removed added link junction ${key}`);
			} catch (error) {
				report.push(`remove failed ${key}: ${String(error)}`);
			}
			if (rel.includes("\\")) {
				const scope = rel.split("\\")[0];
				const scopeKey = `linknm\\${i}\\${scope}`;
				if (!(scopeKey in snap.ledger)) {
					try {
						rmdirSync(join(nm, scope));
						report.push(`removed empty scope dir ${scopeKey}`);
					} catch {
						/* non-empty — keep it */
					}
				}
			}
		}
	}
	const roots = [["plugins", join(home, "plugins")]];
	for (const pkgDir of userPluginRoots(home)) {
		roots.push([`profileplug\\${basename(pkgDir)}`, pkgDir]);
	}
	const linkRoots = snap.linkRoots ?? [];
	for (let i = 0; i < linkRoots.length; i++) {
		roots.push([`linkroot\\${i}`, linkRoots[i]]);
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
		let dst;
		let src;
		if (key.startsWith("plugins\\")) {
			const rest = key.slice("plugins\\".length);
			dst = join(home, "plugins", rest);
			src = join(snap.dir, "plugins", rest);
		} else if (key.startsWith("profileplug\\")) {
			const [pkgName, ...relParts] = key.slice("profileplug\\".length).split("\\");
			dst = join(home, "profiles", "web", "node_modules", pkgName, ...relParts);
			src = join(snap.dir, "profile-plugins", pkgName, ...relParts);
		} else if (key.startsWith("linkroot\\")) {
			const [idxStr, ...relParts] = key.slice("linkroot\\".length).split("\\");
			dst = join(linkRoots[Number(idxStr)], ...relParts);
			src = join(snap.dir, "linkroots", idxStr, ...relParts);
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
