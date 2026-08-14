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
 * Both patches are:
 *   - version-guarded: the installed package.json version must equal the
 *     pinned version exactly, otherwise apply AND restore refuse to touch
 *     the file (an upgraded package may legitimately contain the anchor);
 *   - anchored and unambiguous: every anchor/marker substring must occur
 *     exactly once in the target file, otherwise the patch fails loudly and
 *     writes nothing;
 *   - atomic: the new content is written to a temp file and renamed over the
 *     target, and a failed post-write syntax check reverts the original
 *     bytes;
 *   - idempotent: applying twice is a no-op, restoring twice is a no-op;
 *   - exactly reversible: restore replaces the exact patched text with the
 *     exact official text; any other layout fails loudly and leaves the file
 *     untouched (reinstall the official package to recover).
 *
 * The module depends only on Node built-ins: the watchdog uses it when dsh
 * itself cannot boot.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
		 * patched (restore, however, only accepts the canonical layout). */
		marker: '"keepalive", // dsh-keepalive',
		from: '\t"web-search-deepseek"\n];',
		to: '\t"web-search-deepseek",\n' +
			'\t"keepalive", // dsh-keepalive: keep-alive watchdog configuration card\n' +
			'];',
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

function packageDir(dshRoot, name) {
	/* `name` is the full scoped package name (@deepseek-ai/dsh-host-apiproxy),
	 * so it joins directly under node_modules. */
	return join(dshRoot, "node_modules", name);
}

function readPackage(pkgDir) {
	try {
		const parsed = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
		return { ok: true, version: String(parsed.version ?? "") };
	} catch {
		return { ok: false };
	}
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

/** Version guard shared by apply and restore. */
function versionCheck(dshRoot, patch) {
	const pkgDir = packageDir(dshRoot, patch.package);
	const pkg = readPackage(pkgDir);
	if (!pkg.ok) {
		return { ok: false, reason: "package-not-found", detail: `${patch.package} has no readable package.json under ${pkgDir}` };
	}
	if (pkg.version !== patch.pinnedVersion) {
		return { ok: false, reason: "version-mismatch", detail: `found ${patch.package}@${pkg.version}, pinned ${patch.package}@${patch.pinnedVersion} — refusing to touch the file` };
	}
	return { ok: true };
}

function readTarget(patch, pkgDir) {
	const file = join(pkgDir, ...patch.relativeFile);
	let source;
	try {
		source = readFileSync(file, "utf8");
	} catch (error) {
		return { ok: false, reason: "target-unreadable", detail: `${file}: ${String(error)}` };
	}
	return { ok: true, file, source };
}

function applyOne(dshRoot, patch, log) {
	const guarded = versionCheck(dshRoot, patch);
	if (!guarded.ok) return guarded;
	const target = readTarget(patch, packageDir(dshRoot, patch.package));
	if (!target.ok) return target;
	const { file, source } = target;

	const markerCount = countOccurrences(source, patch.marker);
	if (markerCount > 1) {
		return { ok: false, reason: "ambiguous-marker", detail: `"${patch.marker}" occurs ${markerCount} times in ${file} — refusing to guess` };
	}
	if (markerCount === 1) {
		log(`${patch.package}: already patched (${patch.what})`);
		return { ok: true, status: "already" };
	}

	const anchorCount = countOccurrences(source, patch.from);
	if (anchorCount === 0) {
		return { ok: false, reason: "anchor-missing", detail: `official anchor not found in ${file} — the package layout changed; update the patch` };
	}
	if (anchorCount > 1) {
		return { ok: false, reason: "ambiguous-anchor", detail: `official anchor occurs ${anchorCount} times in ${file} — refusing to guess` };
	}

	const next = source.replace(patch.from, patch.to);
	const written = writeWithVerify(file, source, next);
	if (!written.ok) return written;
	log(`${patch.package}: patched (${patch.what})`);
	return { ok: true, status: "applied" };
}

function restoreOne(dshRoot, patch, log) {
	const guarded = versionCheck(dshRoot, patch);
	if (!guarded.ok) return guarded;
	const target = readTarget(patch, packageDir(dshRoot, patch.package));
	if (!target.ok) return target;
	const { file, source } = target;

	const markerCount = countOccurrences(source, patch.marker);
	if (markerCount === 0) {
		log(`${patch.package}: already restored (no ${patch.what} marker)`);
		return { ok: true, status: "already-restored" };
	}
	if (markerCount > 1) {
		return { ok: false, reason: "ambiguous-marker", detail: `"${patch.marker}" occurs ${markerCount} times in ${file} — refusing to guess` };
	}

	const patchedCount = countOccurrences(source, patch.to);
	if (patchedCount === 0) {
		return {
			ok: false,
			reason: "patch-region-changed",
			detail: `the patched region in ${file} does not match the exact layout this plugin wrote (marker present, canonical text absent) — refusing to edit; reinstall ${patch.package} to restore the official file`
		};
	}
	if (patchedCount > 1) {
		return { ok: false, reason: "ambiguous-patched-region", detail: `the patched region occurs ${patchedCount} times in ${file} — refusing to guess` };
	}

	const next = source.replace(patch.to, patch.from);
	const written = writeWithVerify(file, source, next);
	if (!written.ok) return written;
	log(`${patch.package}: restored official ${patch.what} source`);
	return { ok: true, status: "restored" };
}

/** Run one phase over every patch; `ok` is true iff every patch succeeded. */
function runPhase(dshRoot, phase, log) {
	const results = INSTALLED_PATCHES.map((patch) => {
		const outcome = phase(dshRoot, patch, log);
		return { id: patch.id, package: patch.package, pinnedVersion: patch.pinnedVersion, ...outcome };
	});
	return { ok: results.every((result) => result.ok), results };
}

/**
 * Apply every installed-package patch (idempotent, version-guarded, atomic).
 * @param {{ dshRoot: string, log?: (line: string) => void }} opts
 * @returns {{ ok: boolean, results: Array<{id, package, pinnedVersion, ok, status?, reason?, detail?}> }}
 */
export function ensureInstalledPatches(opts) {
	const log = opts.log ?? (() => {});
	return runPhase(opts.dshRoot, applyOne, log);
}

/**
 * Restore the official content of every patched file (exact reverse,
 * version-guarded, atomic). A file that no longer carries our marker is
 * already restored and left alone.
 * @param {{ dshRoot: string, log?: (line: string) => void }} opts
 * @returns {{ ok: boolean, results: Array<{id, package, pinnedVersion, ok, status?, reason?, detail?}> }}
 */
export function restoreInstalledPatches(opts) {
	const log = opts.log ?? (() => {});
	return runPhase(opts.dshRoot, restoreOne, log);
}
