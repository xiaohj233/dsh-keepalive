/**
 * installed-patches tests (v2): per-target independence, adaptive vs strict
 * version policy, unique anchors, idempotent and atomic apply, strict exact
 * restore, and loud (never-throwing) skips on drift, ambiguity, or an
 * unreadable manifest. Uses a fake DSH install root; never touches the real
 * install.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureInstalledPatches, restoreInstalledPatches, resolveDshRootFromBin, INSTALLED_PATCHES } from "../lib/installed-patches.mjs";
import { makeChecks, makeDshRoot, PRISTINE_APIPROXY, PRISTINE_SUBPROCESS } from "./helpers.mjs";

const { check, done } = makeChecks("installed-patches");
const base = mkdtempSync(join(tmpdir(), "ka-patch-test-"));
const silent = () => {};

const APIPROXY = "@deepseek-ai/dsh-host-apiproxy";
const SUBPROCESS = "@deepseek-ai/dsh-subprocess-local";

/** The canonical patched apiproxy content (what the plugin writes). */
const PATCHED_APIPROXY = PRISTINE_APIPROXY.replace('= [\n\t"agent-loop",', '= [\n\t"keepalive", // dsh-keepalive: keep-alive watchdog configuration card\n\t"agent-loop",');

const findApplied = (report, name) => report.applied.find((entry) => entry.package === name);
const findSkipped = (report, name) => report.skipped.find((entry) => entry.package === name);

try {
	/* ---- resolveDshRootFromBin ---- */
	const fixture = makeDshRoot(base);
	check(resolveDshRootFromBin(fixture.bin).ok === true, "dsh root resolves from the dsh bin.js path");
	check(resolveDshRootFromBin(join(fixture.root, "elsewhere.js")).ok === false, "garbage bin path is rejected");
	check(resolveDshRootFromBin("").ok === false, "empty bin path is rejected");

	/* ---- v2: adaptive mode patches an untested version when the anchor matches ---- */
	const bumped = makeDshRoot(base, { apiproxyVersion: "0.1.0-rc.7" });
	let r = ensureInstalledPatches({ dshRoot: bumped.root, log: silent });
	check(r.ok === true, "adaptive apply is ok when an untested version still matches its anchor");
	const bumpedApi = findApplied(r, APIPROXY);
	check(bumpedApi !== void 0 && bumpedApi.adaptive === true, "untested version patched with adaptive: true");
	check(readFileSync(join(bumped.apiDir, "lib", "index.js"), "utf8") === PATCHED_APIPROXY, "adaptive patch wrote the canonical insertion");
	check(findApplied(r, SUBPROCESS) !== void 0, "the exact-version target also patches in adaptive mode");

	/* ---- v2: adaptive mode skips an untested version whose anchor drifted;
	 * the other target still patches ---- */
	const drifted = makeDshRoot(base, { apiproxyVersion: "0.2.0", apiproxySource: "// a rewritten upstream file\n" });
	r = ensureInstalledPatches({ dshRoot: drifted.root, log: silent });
	check(r.ok === false, "adaptive apply is not ok when an untested version's anchor drifted");
	const driftedSkip = findSkipped(r, APIPROXY);
	check(driftedSkip !== void 0 && driftedSkip.reason === "version-anchor", "drifted untested version skips with version-anchor");
	check(readFileSync(join(drifted.apiDir, "lib", "index.js"), "utf8") === "// a rewritten upstream file\n", "drifted file left untouched");
	check(findApplied(r, SUBPROCESS) !== void 0, "the other target still patches when one drifted");

	/* ---- v2: strict mode refuses every untested version even when anchors match ---- */
	const strictRoot = makeDshRoot(base, { apiproxyVersion: "0.1.0-rc.7" });
	r = ensureInstalledPatches({ dshRoot: strictRoot.root, strict: true, log: silent });
	check(r.ok === false, "strict apply is not ok when a version mismatches");
	const strictSkip = findSkipped(r, APIPROXY);
	check(strictSkip !== void 0 && strictSkip.reason === "version", "strict mode skips an untested version with version");
	check(readFileSync(join(strictRoot.apiDir, "lib", "index.js"), "utf8") === PRISTINE_APIPROXY, "strict-mode mismatch leaves the file untouched");
	check(findApplied(r, SUBPROCESS) !== void 0, "the exact-version target still patches in strict mode");

	/* ---- v2: unreadable manifest skips that package without throwing ---- */
	const badManifest = makeDshRoot(base);
	writeFileSync(join(badManifest.apiDir, "package.json"), "{ not json");
	r = ensureInstalledPatches({ dshRoot: badManifest.root, log: silent });
	check(r.ok === false, "unreadable manifest makes the run not ok");
	check(findSkipped(r, APIPROXY)?.reason === "unreadable-manifest", "unreadable manifest skips with unreadable-manifest");
	check(findApplied(r, SUBPROCESS) !== void 0, "the readable target still patches when a manifest is unreadable");
	check(readFileSync(join(badManifest.subDir, "lib", "index.js"), "utf8").includes("/* dsh-keepalive patch:"), "readable target actually patched");
	r = restoreInstalledPatches({ dshRoot: badManifest.root, log: silent });
	check(findSkipped(r, APIPROXY)?.reason === "unreadable-manifest", "restore skips an unreadable manifest without throwing");
	check(r.reverted.some((entry) => entry.package === SUBPROCESS), "restore still reverts the readable target");

	/* ---- missing package is reported, not guessed around ---- */
	const missing = makeDshRoot(base);
	rmSync(join(missing.root, "node_modules", "@deepseek-ai", "dsh-subprocess-local"), { recursive: true, force: true });
	r = ensureInstalledPatches({ dshRoot: missing.root, log: silent });
	check(findSkipped(r, SUBPROCESS)?.reason === "package-not-found", "apply reports a missing package directory");
	check(findApplied(r, APIPROXY) !== void 0, "the present package still patches when one is missing");
	r = restoreInstalledPatches({ dshRoot: missing.root, log: silent });
	check(findSkipped(r, SUBPROCESS)?.reason === "package-not-found", "restore reports a missing package directory");
	check(r.reverted.some((entry) => entry.package === APIPROXY), "restore still reverts the present package");

	/* ---- version match + anchor missing → skip(anchor); other target still patches ---- */
	const noAnchor = makeDshRoot(base, { apiproxySource: "// a rewritten upstream file\n" });
	r = ensureInstalledPatches({ dshRoot: noAnchor.root, log: silent });
	check(r.ok === false, "missing anchor makes the run not ok");
	const noAnchorSkip = findSkipped(r, APIPROXY);
	check(noAnchorSkip !== void 0 && noAnchorSkip.reason === "anchor", "version-matched copy with a missing anchor skips with anchor");
	check(noAnchorSkip.detail.includes("missing-anchor"), "anchor skip names the missing-anchor reason");
	check(findApplied(r, SUBPROCESS) !== void 0, "the other target still patches when one anchor is missing");

	/* ---- version match + ambiguous anchor → skip(anchor), file untouched ---- */
	const ambiguousSource = PRISTINE_APIPROXY + '\nconst SECOND_ALLOWLIST = [\n\t"agent-loop",\n];\n';
	const ambiguous = makeDshRoot(base, { apiproxySource: ambiguousSource });
	r = ensureInstalledPatches({ dshRoot: ambiguous.root, log: silent });
	const amb = findSkipped(r, APIPROXY);
	check(amb !== void 0 && amb.reason === "anchor" && amb.detail.includes("ambiguous-anchor"), "ambiguous anchor skips with anchor/ambiguous-anchor");
	check(readFileSync(join(ambiguous.apiDir, "lib", "index.js"), "utf8") === ambiguousSource, "ambiguous-anchor file left untouched");

	/* ---- apply on pristine: exactly the canonical delta ---- */
	const pristine = makeDshRoot(base);
	r = ensureInstalledPatches({ dshRoot: pristine.root, log: silent });
	check(r.ok === true && r.applied.length === 2 && r.skipped.length === 0, "apply patches both pristine files");
	check(r.applied.every((entry) => entry.adaptive !== true), "exact-version patches are not marked adaptive");
	check(readFileSync(join(pristine.apiDir, "lib", "index.js"), "utf8") === PATCHED_APIPROXY, "apiproxy delta is exactly the canonical insertion");
	const subPatched = readFileSync(join(pristine.subDir, "lib", "index.js"), "utf8");
	check(subPatched !== PRISTINE_SUBPROCESS && subPatched.includes("windowsHide: true"), "subprocess delta inserts windowsHide only");

	/* ---- idempotent re-apply ---- */
	const apiAfterFirst = readFileSync(join(pristine.apiDir, "lib", "index.js"), "utf8");
	r = ensureInstalledPatches({ dshRoot: pristine.root, log: silent });
	check(r.ok === true && r.applied.length === 0 && r.skipped.length === 2, "re-apply is a no-op");
	check(r.skipped.every((entry) => entry.reason === "already-patched"), "re-apply skips every copy with already-patched");
	check(readFileSync(join(pristine.apiDir, "lib", "index.js"), "utf8") === apiAfterFirst, "re-apply leaves the file byte-identical");

	/* ---- coexistence: dsh-tavily-search-provider's tail row does not
	 * consume the head anchor, so keepalive still patches ---- */
	const coexistBase = mkdtempSync(join(tmpdir(), "ka-coexist-"));
	const tavilyInstalled = makeDshRoot(coexistBase, {
		apiproxySource: PRISTINE_APIPROXY.replace('\t"web-search-deepseek"', '\t"web-search-deepseek",\n\t"dsh-tavily-search-provider"')
	});
	r = ensureInstalledPatches({ dshRoot: tavilyInstalled.root, log: silent });
	check(findApplied(r, APIPROXY) !== void 0, "keepalive patches when the Tavily tail row is already present");
	const tavilyCoexist = readFileSync(join(tavilyInstalled.apiDir, "lib", "index.js"), "utf8");
	check(tavilyCoexist.includes('const WEB_SETTINGS_NAMESPACES = [\n\t"keepalive", // dsh-keepalive'), "keepalive row is inserted at the top of the array");
	check(tavilyCoexist.includes('"dsh-tavily-search-provider"'), "the Tavily tail row survives keepalive's head insertion");
	r = restoreInstalledPatches({ dshRoot: tavilyInstalled.root, log: silent });
	check(r.ok === true && r.reverted.length === 2, "restore works on the coexisting layout");
	check(readFileSync(join(tavilyInstalled.apiDir, "lib", "index.js"), "utf8").includes('"dsh-tavily-search-provider"'), "restore keeps the other plugin's row");
	rmSync(coexistBase, { recursive: true, force: true });

	/* ---- legacy tail layout from an older keepalive release counts as
	 * already-patched (marker prefix), never duplicated at the head ---- */
	const legacyBase = mkdtempSync(join(tmpdir(), "ka-legacy-"));
	const legacyTail = makeDshRoot(legacyBase, {
		apiproxySource: PRISTINE_APIPROXY.replace('\t"web-search-deepseek"', '\t"web-search-deepseek",\n\t"keepalive", // dsh-keepalive: keep-alive watchdog configuration card')
	});
	r = ensureInstalledPatches({ dshRoot: legacyTail.root, log: silent });
	const legacySkip = findSkipped(r, APIPROXY);
	check(legacySkip !== void 0 && legacySkip.reason === "already-patched", "a legacy tail keepalive row is treated as already-patched");
	const legacyFile = readFileSync(join(legacyTail.apiDir, "lib", "index.js"), "utf8");
	check(legacyFile.split('"keepalive", // dsh-keepalive').length - 1 === 1, "no duplicate keepalive row is added over a legacy tail row");
	rmSync(legacyBase, { recursive: true, force: true });

	/* ---- byte-level roundtrip ---- */
	r = restoreInstalledPatches({ dshRoot: pristine.root, log: silent });
	check(r.ok === true && r.reverted.length === 2, "restore reverts both patches");
	check(readFileSync(join(pristine.apiDir, "lib", "index.js"), "utf8") === PRISTINE_APIPROXY, "apiproxy file byte-identical to pristine after restore");
	check(readFileSync(join(pristine.subDir, "lib", "index.js"), "utf8") === PRISTINE_SUBPROCESS, "subprocess file byte-identical to pristine after restore");
	r = restoreInstalledPatches({ dshRoot: pristine.root, log: silent });
	check(r.ok === true && r.reverted.length === 0 && r.skipped.every((entry) => entry.reason === "already-restored"), "second restore is a no-op (already-restored)");

	/* ---- restore is strict: untested version refused even with marker present ---- */
	const strictRestore = makeDshRoot(base, { apiproxyVersion: "0.1.0-rc.7", apiproxySource: PATCHED_APIPROXY });
	r = restoreInstalledPatches({ dshRoot: strictRestore.root, log: silent });
	check(r.ok === false, "restore is not ok when a version mismatches");
	check(findSkipped(r, APIPROXY)?.reason === "version", "restore refuses an untested version with version");
	check(readFileSync(join(strictRestore.apiDir, "lib", "index.js"), "utf8") === PATCHED_APIPROXY, "restore never strips an upgraded package blindly");

	/* ---- restore blocked: non-canonical patched region ---- */
	const drifted2 = makeDshRoot(base, {
		apiproxySource: PRISTINE_APIPROXY.replace('= [\n\t"agent-loop",', '= [\n\t"keepalive", // dsh-keepalive: edited by someone else\n\t"agent-loop",')
	});
	r = restoreInstalledPatches({ dshRoot: drifted2.root, log: silent });
	const drift = findSkipped(r, APIPROXY);
	check(drift !== void 0 && drift.reason === "restore-blocked" && drift.detail.includes("marker-without-to"), "restore refuses a non-canonical patched region (restore-blocked)");
	check(readFileSync(join(drifted2.apiDir, "lib", "index.js"), "utf8").includes("edited by someone else"), "drifted file left untouched by restore");

	/* ---- restore blocked: patched region occurs twice ---- */
	const doubledTo = makeDshRoot(base, { apiproxySource: PATCHED_APIPROXY + "\n" + PATCHED_APIPROXY });
	r = restoreInstalledPatches({ dshRoot: doubledTo.root, log: silent });
	const dblTo = findSkipped(r, APIPROXY);
	check(dblTo !== void 0 && dblTo.reason === "restore-blocked" && dblTo.detail.includes("ambiguous-to"), "restore refuses a doubled patched region (restore-blocked)");
	check(readFileSync(join(doubledTo.apiDir, "lib", "index.js"), "utf8") === PATCHED_APIPROXY + "\n" + PATCHED_APIPROXY, "doubled-region file left untouched by restore");

	/* ---- apply with a doubled marker is already-patched (idempotent) ---- */
	const dupMarker = makeDshRoot(base, { apiproxySource: PATCHED_APIPROXY + '\n// "keepalive", // dsh-keepalive legacy comment\n' });
	r = ensureInstalledPatches({ dshRoot: dupMarker.root, log: silent });
	const dup = findSkipped(r, APIPROXY);
	check(dup !== void 0 && dup.reason === "already-patched", "apply treats a doubled marker as already-patched");
	check(readFileSync(join(dupMarker.apiDir, "lib", "index.js"), "utf8") === PATCHED_APIPROXY + '\n// "keepalive", // dsh-keepalive legacy comment\n', "doubled-marker file left untouched by apply");

	/* ---- double-anchor dedupe: the same physical file reachable from two
	 * anchors is patched exactly once ---- */
	const dedupe = makeDshRoot(base);
	r = ensureInstalledPatches({
		dshRoot: dedupe.root,
		anchors: [join(dedupe.root, "package.json"), join(dedupe.root, "lib", "package.json")],
		log: silent
	});
	check(r.ok === true && r.applied.length === 2, "two anchors resolving the same files patch exactly once");
	const dedupedApi = readFileSync(join(dedupe.apiDir, "lib", "index.js"), "utf8");
	check(dedupedApi.split('"keepalive", // dsh-keepalive').length - 1 === 1, "apiproxy marker appears exactly once after dedupe");
	check(readFileSync(join(dedupe.subDir, "lib", "index.js"), "utf8").split("/* dsh-keepalive patch:").length - 1 === 1, "subprocess marker appears exactly once after dedupe");

	/* ---- atomic apply: syntax-check failure reverts the file ---- */
	const brokenSource = "const broken = ;\n" + PRISTINE_APIPROXY;
	const broken = makeDshRoot(base, { apiproxySource: brokenSource });
	r = ensureInstalledPatches({ dshRoot: broken.root, log: silent });
	const bad = findSkipped(r, APIPROXY);
	check(bad !== void 0 && bad.reason === "syntax-check-failed", "apply fails when the patched file fails node --check");
	check(readFileSync(join(broken.apiDir, "lib", "index.js"), "utf8") === brokenSource, "syntax-check failure reverts the file to its previous bytes");

	/* ---- patch catalog sanity ---- */
	check(INSTALLED_PATCHES.length === 2, "exactly two patches are declared");
	check(INSTALLED_PATCHES.every((p) => p.marker.length > 0 && p.from.length > 0 && p.to.length > 0 && p.to.includes(p.marker)), "every patch declares a marker contained in its patched text");
} finally {
	rmSync(base, { recursive: true, force: true });
}

process.exit(done() ? 0 : 1);
