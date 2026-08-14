/**
 * installed-patches — the exact, anchored source patches dsh-keepalive
 * applies to the DSH install, as one reusable module.
 *
 * Two patches exist today:
 *
 *   1. `@deepseek-ai/dsh-host-apiproxy@0.1.0-rc.6` — add the `keepalive`
 *      settings namespace to the WEB_SETTINGS_NAMESPACES allowlist so the
 *      Settings → Plugins configuration card can read and save the
 *      `keepalive:` section (a namespace outside the allowlist answers
 *      `settings-not-exposed` even when registered).
 *   2. `@deepseek-ai/dsh-subprocess-local@0.1.0-rc.6` — spawn tool
 *      subprocesses (pwsh/bash/ripgrep) with `windowsHide: true` so the
 *      headless host, which has no console of its own, does not pop a
 *      console window per invocation on Windows.
 *
 * Patch engine semantics (v2 — per-target independence, never throws for
 * installation-state reasons, atomic verified writes):
 *
 *   - Every installed copy is resolved through its package.json manifest and
 *     decided INDEPENDENTLY: a version mismatch, an unreadable manifest, or a
 *     drifted anchor on one copy can never block another copy, and none of
 *     these conditions throws — the watchdog and the host must keep running
 *     even when a patch cannot apply.
 *   - apply (`ensureInstalledPatches`): `strict: false` (default, adaptive)
 *     patches an untested version when its anchor still matches uniquely
 *     (recorded as `adaptive: true`); `strict: true` refuses every untested
 *     version (`skip(version)`). A version-mismatched copy whose anchor is
 *     missing or ambiguous is `skip(version-anchor)`; a matched-version copy
 *     with a missing or ambiguous anchor is `skip(anchor)`. A marker already
 *     present is `skip(already-patched)` (idempotent). Only successfully
 *     classified copies are written, atomically (temp file + rename) and
 *     verified with `node --check`; a failed verification reverts the
 *     original bytes.
 *   - restore (`restoreInstalledPatches`) is ALWAYS strict: version mismatch
 *     → `skip(version)`; marker present without exactly its canonical
 *     patched text → `skip(restore-blocked)`; marker absent →
 *     `skip(already-restored)`.
 *   - Resolution walks node's upward node_modules lookup from each anchor
 *     and deduplicates by real path, so the same physical file reachable
 *     from several anchors (e.g. a junctioned node_modules) is patched once.
 *
 * The module depends only on Node built-ins: the watchdog uses it when dsh
 * itself cannot boot.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** One installed-package patch entry. `from` is official text, `to` patched. */
export const INSTALLED_PATCHES = Object.freeze([
	{
		id: "apiproxy-settings-namespace",
		package: "@deepseek-ai/dsh-host-apiproxy",
		pinnedVersion: "0.1.0-rc.6",
		relativeFile: ["lib", "index.js"],
		/* Marker: the distinctive text that proves OUR entry is present.
		 * Keep it short and prefix-shaped so a file patched by an older
		 * release of this plugin with a longer comment still counts as
		 * patched (restore, however, only accepts the canonical layout).
		 *
		 * The insertion anchor is the TOP of the array: the official
		 * `web-search-deepseek` tail anchor is shared with
		 * dsh-tavily-search-provider, so tail insertion would consume the
		 * other plugin's anchor. Head insertion never touches the tail, so
		 * both plugins can coexist regardless of install order. */
		marker: '"keepalive", // dsh-keepalive',
		from: '= [\n\t"agent-loop",',
		to: '= [\n' +
			'\t"keepalive", // dsh-keepalive: keep-alive watchdog configuration card\n' +
			'\t"agent-loop",',
		what: "expose the keepalive settings namespace to the Web client"
	},
	{
		id: "subprocess-windowshide",
		package: "@deepseek-ai/dsh-subprocess-local",
		pinnedVersion: "0.1.0-rc.6",
		relativeFile: ["lib", "index.js"],
		marker: "/* dsh-keepalive patch:",
		from: '\t\tdetached: platform !== "win32"\n\t});',
		to: '\t\tdetached: platform !== "win32",\n' +
			'\t\t/* dsh-keepalive patch: on Windows the host node process has no console,\n' +
			'\t\t * so without this flag every tool invocation (pwsh/bash/ripgrep)\n' +
			"\t\t * pops a new console window on the user's desktop. */\n" +
			'\t\twindowsHide: true\n' +
			'\t});',
		what: "spawn tool subprocesses windowless on Windows"
	}
]);

/**
 * Resolve the DSH install root from the dsh bin.js path (`<root>/lib/bin.js`).
 * The root must contain a `node_modules/@deepseek-ai` directory, otherwise
 * the caller is handed a garbage root.
 * @param {string} bin - absolute path to the dsh bin.js.
 * @returns {{ ok: true, root: string } | { ok: false, error: string }}
 */
export function resolveDshRootFromBin(bin) {
	if (typeof bin !== "string" || bin.length === 0) {
		return { ok: false, error: "no dsh bin.js path given" };
	}
	const root = dirname(dirname(bin));
	if (!existsSync(join(root, "node_modules", "@deepseek-ai"))) {
		return { ok: false, error: `no node_modules/@deepseek-ai under ${root} (is ${bin} really the dsh bin.js?)` };
	}
	return { ok: true, root };
}

function countOccurrences(text, needle) {
	if (needle.length === 0) return 0;
	let count = 0;
	let index = 0;
	while (true) {
		const at = text.indexOf(needle, index);
		if (at === -1) return count;
		count += 1;
		index = at + needle.length;
	}
}

/** Atomic file replace: write `content` to a temp sibling, then rename over. */
function atomicWrite(file, content) {
	const tmp = `${file}.keepalive-tmp`;
	writeFileSync(tmp, content);
	renameSync(tmp, file);
}

/** `node --check` the target so a patch can never ship broken JS. */
function syntaxCheck(file) {
	try {
		const res = spawnSync(process.execPath, ["--check", file], {
			timeout: 20000,
			windowsHide: true,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"]
		});
		return res.status === 0;
	} catch {
		return false;
	}
}

/**
 * Write `next` to `file` atomically, verify it with `node --check`, and
 * revert to `original` when the verification fails. The file is either the
 * requested new content or its exact previous bytes — never a partial write.
 */
function writeWithVerify(file, original, next) {
	try {
		atomicWrite(file, next);
	} catch (error) {
		return { ok: false, reason: "write-failed", detail: String(error) };
	}
	if (!syntaxCheck(file)) {
		try {
			atomicWrite(file, original);
		} catch {
			/* the file is `next` (syntactically broken) and could not be
			 * reverted — report loudly so the operator can reinstall. */
			return { ok: false, reason: "syntax-check-failed", detail: "post-write syntax check failed and the original bytes could not be restored — reinstall the official package" };
		}
		return { ok: false, reason: "syntax-check-failed", detail: "post-write syntax check failed; file reverted to its previous bytes" };
	}
	return { ok: true };
}

/** Normalize an anchor (possibly a `file://` URL, as with import.meta.url) to a plain path. */
function anchorPath(anchor) {
	return typeof anchor === "string" && anchor.startsWith("file://") ? fileURLToPath(anchor) : anchor;
}

/**
 * Find `<anchor dir>/node_modules/<packageName>/package.json`, replicating
 * node's upward node_modules walk (junctions and symlinks are followed
 * transparently by the filesystem). Returns the manifest path, or null when
 * the package is not installed under this anchor.
 */
function findManifest(anchorPathValue, packageName) {
	let dir = dirname(anchorPathValue);
	for (;;) {
		const candidate = join(dir, "node_modules", packageName, "package.json");
		try {
			if (statSync(candidate).isFile()) return candidate;
		} catch {
			/* keep walking up */
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * Resolve one (patch, anchor) pair. Returns null when the package (or its
 * target file) is not installed at this anchor. An installed package whose
 * manifest cannot be read resolves to a descriptor with `manifestError` set;
 * the decision whether an installed version may be patched belongs to the
 * caller, never here — so an unreadable or unsupported copy can never brick
 * module loading.
 */
function resolveTarget(anchor, patch) {
	const manifestPath = findManifest(anchor, patch.package);
	if (manifestPath === null) return null;
	const root = dirname(manifestPath);
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch (error) {
		return { package: patch.package, root, version: null, manifestError: error instanceof Error ? error.message : String(error) };
	}
	try {
		return { package: patch.package, root, version: manifest.version, file: realpathSync(join(root, ...patch.relativeFile)) };
	} catch {
		return null;
	}
}

/**
 * Every reachable copy of every patch across the anchors, deduplicated by
 * real path so a junctioned fallback adds no second patch pass. Patches that
 * no anchor resolves are reported as `missing` so the caller can still
 * refuse them instead of guessing around a missing install.
 */
function resolveTargets(anchors) {
	const seen = new Set();
	const found = new Set();
	const targets = [];
	for (const anchor of anchors) {
		for (const patch of INSTALLED_PATCHES) {
			const resolved = resolveTarget(anchorPath(anchor), patch);
			if (resolved === null) continue;
			/* Unreadable-manifest descriptors have no file; dedupe them by
			 * package + root so the caller still sees (and refuses) them. */
			const key = resolved.file ?? `${resolved.package}@${resolved.root}`;
			if (seen.has(key)) continue;
			seen.add(key);
			found.add(patch.id);
			targets.push({ ...resolved, id: patch.id, pinnedVersion: patch.pinnedVersion, patch });
		}
	}
	const missing = INSTALLED_PATCHES
		.filter((patch) => !found.has(patch.id))
		.map((patch) => patch.id);
	return { targets, missing };
}

/** The skip entry shape shared by apply and restore reports. */
function skipEntry(id, packageName, file, reason, detail) {
	return { id, package: packageName, ...(file === void 0 ? {} : { file }), reason, ...(detail === void 0 ? {} : { detail }) };
}

/**
 * Apply every installed-package patch (v2 — per-target independence, adaptive
 * by default, atomic + `node --check`-verified writes; NEVER throws for
 * installation-state reasons).
 *
 * Version policy:
 * - `strict: false` (default, adaptive): an untested version is patched when
 *   its anchor still matches uniquely (recorded as `adaptive: true`);
 *   otherwise that copy is skipped with `version-anchor`.
 * - `strict: true`: only exact pinned versions are patched; every other copy
 *   is skipped with `version`.
 * - A target whose manifest is unreadable or whose file cannot be read is
 *   skipped with a reason; a missing/ambiguous anchor skips ONLY that copy —
 *   other copies still patch. A marker already present skips with
 *   `already-patched` (idempotent, not a failure).
 *
 * Each copy is decided independently and only successfully classified copies
 * are written (temp file + rename + post-write `node --check` with byte
 * rollback on failure).
 * @param {{ dshRoot: string, log?: (line: string) => void, strict?: boolean, anchors?: string[] }} opts
 *   - `dshRoot` — the DSH install root (see {@link resolveDshRootFromBin}).
 *   - `strict` — strict version policy (see above).
 *   - `anchors` — an exact anchor list, replacing the default
 *     `[<dshRoot>/package.json]`; targets are deduplicated by real path.
 * @returns {{ ok: boolean, summary: string, applied: Array<{id, package, file, adaptive?}>, skipped: Array<{id, package, file?, reason, detail?}> }}
 *   `ok` is false when any copy was skipped for a failure reason (version in
 *   strict mode, unreadable manifest/file, missing/ambiguous anchors, write
 *   or syntax-check failure); `already-patched` skips are not failures.
 */
export function ensureInstalledPatches(opts) {
	const log = opts.log ?? (() => {});
	const strict = opts.strict === true;
	if (typeof opts.dshRoot !== "string" || opts.dshRoot.length === 0) {
		throw new Error("dsh-keepalive: ensureInstalledPatches requires a dshRoot");
	}
	const anchors = opts.anchors ?? [join(opts.dshRoot, "package.json")];
	/* Development-time guard: every patch's replacement text must carry its
	 * own marker, or the second boot would fail to find the (already
	 * rewritten) anchor. This check makes that class of bug fail loudly at
	 * patch time. */
	for (const patch of INSTALLED_PATCHES) {
		if (!patch.to.includes(patch.marker)) {
			throw new Error(`dsh-keepalive: patch "${patch.what}" does not embed its marker "${patch.marker}" in the replacement text — idempotency would break on the next boot`);
		}
	}
	const { targets, missing } = resolveTargets(anchors);
	const applied = [];
	const skipped = [];
	for (const target of targets) {
		const expected = target.pinnedVersion;
		const versionOk = target.manifestError === void 0 && target.version === expected;
		if (target.manifestError !== void 0) {
			skipped.push(skipEntry(target.id, target.package, target.root, "unreadable-manifest", target.manifestError));
			continue;
		}
		let source;
		try {
			source = readFileSync(target.file, "utf8");
		} catch (error) {
			skipped.push(skipEntry(target.id, target.package, target.file, "unreadable-file", error instanceof Error ? error.message : String(error)));
			continue;
		}
		if (!versionOk && strict) {
			skipped.push(skipEntry(target.id, target.package, target.file, "version", `installed "${target.version}", supported "${expected}" (strict mode)`));
			continue;
		}
		const patch = target.patch;
		if (source.includes(patch.marker)) {
			log(`${target.package}: already patched (${patch.what})`);
			skipped.push(skipEntry(target.id, target.package, target.file, "already-patched"));
			continue;
		}
		const anchorCount = countOccurrences(source, patch.from);
		if (anchorCount === 0) {
			skipped.push(skipEntry(target.id, target.package, target.file, versionOk ? "anchor" : "version-anchor",
				`missing-anchor: official anchor not found in ${target.file} — the package layout changed; update the patch${versionOk ? "" : ` (installed "${target.version}", supported "${expected}")`}`));
			continue;
		}
		if (anchorCount > 1) {
			skipped.push(skipEntry(target.id, target.package, target.file, versionOk ? "anchor" : "version-anchor",
				`ambiguous-anchor: official anchor occurs ${anchorCount} times in ${target.file} — refusing to guess${versionOk ? "" : ` (installed "${target.version}", supported "${expected}")`}`));
			continue;
		}
		const next = source.replace(patch.from, patch.to);
		const written = writeWithVerify(target.file, source, next);
		if (!written.ok) {
			skipped.push(skipEntry(target.id, target.package, target.file, written.reason, written.detail));
			continue;
		}
		log(`${target.package}: patched (${patch.what})${versionOk ? "" : " (adaptive version match)"}`);
		applied.push({ id: target.id, package: target.package, file: target.file, ...(versionOk ? {} : { adaptive: true }) });
	}
	for (const id of missing) {
		const patch = INSTALLED_PATCHES.find((entry) => entry.id === id);
		skipped.push(skipEntry(id, patch.package, void 0, "package-not-found",
			`${patch.package} is not installed with its target file reachable from the given anchors — not guessing around a missing install`));
	}
	const failureSkipped = skipped.filter((entry) => entry.reason !== "already-patched");
	const alreadyCount = skipped.length - failureSkipped.length;
	const summary = applied.length === 0 && failureSkipped.length === 0
		? `all ${INSTALLED_PATCHES.length} patches already present`
		: [
			applied.length > 0 ? `patched ${applied.map((entry) => `${entry.package}${entry.adaptive === true ? " (adaptive version match)" : ""}`).join(", ")}` : "",
			failureSkipped.length > 0 ? `skipped ${failureSkipped.map((entry) => `${entry.package} (${entry.reason})`).join(", ")}` : "",
			alreadyCount > 0 ? `already patched: ${alreadyCount}` : ""
		].filter(Boolean).join("; ");
	return { ok: failureSkipped.length === 0, summary, applied, skipped };
}

/**
 * Restore the official content of every patched file (v2 — ALWAYS strict,
 * exact reverse, atomic + verified, NEVER throws for installation-state
 * reasons). A version mismatch, an unreadable manifest/file, or a marker
 * present without exactly its canonical patched text skips that copy with a
 * reason and never writes it; a marker already gone is `already-restored`
 * (idempotent, not a failure).
 * @param {{ dshRoot: string, log?: (line: string) => void, anchors?: string[] }} opts
 *   - `dshRoot` — the DSH install root (see {@link resolveDshRootFromBin}).
 *   - `anchors` — an exact anchor list, replacing the default
 *     `[<dshRoot>/package.json]`; targets are deduplicated by real path.
 * @returns {{ ok: boolean, summary: string, reverted: Array<{id, package, file}>, skipped: Array<{id, package, file?, reason, detail?}> }}
 *   `ok` is false when any copy was skipped for a failure reason (version,
 *   unreadable manifest/file, restore-blocked, write or syntax-check
 *   failure); `already-restored` skips are not failures.
 */
export function restoreInstalledPatches(opts) {
	const log = opts.log ?? (() => {});
	if (typeof opts.dshRoot !== "string" || opts.dshRoot.length === 0) {
		throw new Error("dsh-keepalive: restoreInstalledPatches requires a dshRoot");
	}
	const anchors = opts.anchors ?? [join(opts.dshRoot, "package.json")];
	const { targets, missing } = resolveTargets(anchors);
	const reverted = [];
	const skipped = [];
	for (const target of targets) {
		const expected = target.pinnedVersion;
		if (target.manifestError !== void 0) {
			skipped.push(skipEntry(target.id, target.package, target.root, "unreadable-manifest", target.manifestError));
			continue;
		}
		if (target.version !== expected) {
			skipped.push(skipEntry(target.id, target.package, target.file, "version", `installed "${target.version}", supported "${expected}" — restoring an untested version is refused`));
			continue;
		}
		let source;
		try {
			source = readFileSync(target.file, "utf8");
		} catch (error) {
			skipped.push(skipEntry(target.id, target.package, target.file, "unreadable-file", error instanceof Error ? error.message : String(error)));
			continue;
		}
		const patch = target.patch;
		if (!source.includes(patch.marker)) {
			log(`${target.package}: already restored (no ${patch.what} marker)`);
			skipped.push(skipEntry(target.id, target.package, target.file, "already-restored"));
			continue;
		}
		const patchedCount = countOccurrences(source, patch.to);
		if (patchedCount === 0) {
			skipped.push(skipEntry(target.id, target.package, target.file, "restore-blocked",
				`marker-without-to: the patched region in ${target.file} does not match the exact layout this plugin wrote (marker present, canonical text absent) — refusing to edit; reinstall ${target.package} to restore the official file`));
			continue;
		}
		if (patchedCount > 1) {
			skipped.push(skipEntry(target.id, target.package, target.file, "restore-blocked",
				`ambiguous-to: the patched region occurs ${patchedCount} times in ${target.file} — refusing to guess`));
			continue;
		}
		const next = source.replace(patch.to, patch.from);
		const written = writeWithVerify(target.file, source, next);
		if (!written.ok) {
			skipped.push(skipEntry(target.id, target.package, target.file, written.reason, written.detail));
			continue;
		}
		log(`${target.package}: restored official ${patch.what} source`);
		reverted.push({ id: target.id, package: target.package, file: target.file });
	}
	for (const id of missing) {
		const patch = INSTALLED_PATCHES.find((entry) => entry.id === id);
		skipped.push(skipEntry(id, patch.package, void 0, "package-not-found",
			`${patch.package} is not installed with its target file reachable from the given anchors — not guessing around a missing install`));
	}
	const failureSkipped = skipped.filter((entry) => entry.reason !== "already-restored");
	const alreadyCount = skipped.length - failureSkipped.length;
	const summary = reverted.length === 0 && failureSkipped.length === 0
		? `all ${INSTALLED_PATCHES.length} patches already restored`
		: [
			reverted.length > 0 ? `restored ${reverted.map((entry) => entry.package).join(", ")}` : "",
			failureSkipped.length > 0 ? `refused ${failureSkipped.map((entry) => `${entry.package} (${entry.reason})`).join(", ")}` : "",
			alreadyCount > 0 ? `already restored: ${alreadyCount}` : ""
		].filter(Boolean).join("; ");
	return { ok: failureSkipped.length === 0, summary, reverted, skipped };
}
