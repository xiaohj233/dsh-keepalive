/**
 * installed-patches tests: version guards, unique anchors, idempotent and
 * atomic apply, exact restore, and loud failure on ambiguity or drift.
 * Uses a fake DSH install root; never touches the real install.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureInstalledPatches, restoreInstalledPatches, resolveDshRootFromBin, INSTALLED_PATCHES } from "../lib/installed-patches.mjs";
import { makeChecks, makeDshRoot, PRISTINE_APIPROXY, PRISTINE_SUBPROCESS } from "./helpers.mjs";

const { check, done } = makeChecks("installed-patches");
const base = mkdtempSync(join(tmpdir(), "ka-patch-test-"));
const silent = () => {};

try {
	/* ---- resolveDshRootFromBin ---- */
	const fixture = makeDshRoot(base);
	check(resolveDshRootFromBin(fixture.bin).ok === true, "dsh root resolves from the dsh bin.js path");
	check(resolveDshRootFromBin(join(fixture.root, "elsewhere.js")).ok === false, "garbage bin path is rejected");
	check(resolveDshRootFromBin("").ok === false, "empty bin path is rejected");

	/* ---- apply on pristine: exactly the canonical delta ---- */
	let r = ensureInstalledPatches({ dshRoot: fixture.root, log: silent });
	check(r.ok === true && r.results.every((x) => x.ok && x.status === "applied"), "apply patches pristine files");
	const apiPatched = readFileSync(join(fixture.apiDir, "lib", "index.js"), "utf8");
	const subPatched = readFileSync(join(fixture.subDir, "lib", "index.js"), "utf8");
	check(apiPatched.includes('"keepalive", // dsh-keepalive'), "apiproxy marker present after apply");
	check(subPatched.includes("/* dsh-keepalive patch:"), "subprocess marker present after apply");
	check(apiPatched === PRISTINE_APIPROXY.replace('\t"web-search-deepseek"\n];', '\t"web-search-deepseek",\n\t"keepalive", // dsh-keepalive: keep-alive watchdog configuration card\n];'), "apiproxy delta is exactly the canonical insertion");
	check(subPatched !== PRISTINE_SUBPROCESS && subPatched.includes("windowsHide: true"), "subprocess delta inserts windowsHide only");

	/* ---- idempotent re-apply ---- */
	const apiAfterFirst = readFileSync(join(fixture.apiDir, "lib", "index.js"), "utf8");
	r = ensureInstalledPatches({ dshRoot: fixture.root, log: silent });
	check(r.ok === true && r.results.every((x) => x.status === "already"), "re-apply is a no-op (already)");
	check(readFileSync(join(fixture.apiDir, "lib", "index.js"), "utf8") === apiAfterFirst, "re-apply leaves the file byte-identical");

	/* ---- exact restore ---- */
	r = restoreInstalledPatches({ dshRoot: fixture.root, log: silent });
	check(r.ok === true && r.results.every((x) => x.status === "restored"), "restore reverts both patches");
	check(readFileSync(join(fixture.apiDir, "lib", "index.js"), "utf8") === PRISTINE_APIPROXY, "apiproxy file byte-identical to pristine after restore");
	check(readFileSync(join(fixture.subDir, "lib", "index.js"), "utf8") === PRISTINE_SUBPROCESS, "subprocess file byte-identical to pristine after restore");
	r = restoreInstalledPatches({ dshRoot: fixture.root, log: silent });
	check(r.ok === true && r.results.every((x) => x.status === "already-restored"), "second restore is a no-op (already-restored)");

	/* ---- version mismatch refuses apply AND restore ---- */
	const bumped = makeDshRoot(base, { apiproxyVersion: "0.1.0-rc.7" });
	r = ensureInstalledPatches({ dshRoot: bumped.root, log: silent });
	const apiMismatch = r.results.find((x) => x.package === "@deepseek-ai/dsh-host-apiproxy");
	check(apiMismatch.ok === false && apiMismatch.reason === "version-mismatch", "apply refuses a version-mismatched package");
	check(readFileSync(join(bumped.apiDir, "lib", "index.js"), "utf8") === PRISTINE_APIPROXY, "version-mismatched file untouched by apply");
	const subOk = r.results.find((x) => x.package === "@deepseek-ai/dsh-subprocess-local");
	check(subOk.ok === true, "the other, matching package still patches");
	r = restoreInstalledPatches({ dshRoot: bumped.root, log: silent });
	check(r.results.find((x) => x.package === "@deepseek-ai/dsh-host-apiproxy").reason === "version-mismatch", "restore refuses a version-mismatched package");
	writeFileSync(join(bumped.apiDir, "lib", "index.js"), PRISTINE_APIPROXY.replace('\t"web-search-deepseek"\n];', '\t"web-search-deepseek",\n\t"keepalive", // dsh-keepalive: keep-alive watchdog configuration card\n];'));
	r = restoreInstalledPatches({ dshRoot: bumped.root, log: silent });
	check(r.results.find((x) => x.package === "@deepseek-ai/dsh-host-apiproxy").reason === "version-mismatch", "restore still refuses even with a marker present (never strip an upgraded package blindly)");

	/* ---- missing package ---- */
	const missing = makeDshRoot(base, { apiproxyVersion: "0.1.0-rc.6" });
	rmSync(join(missing.root, "node_modules", "@deepseek-ai", "dsh-subprocess-local"), { recursive: true, force: true });
	r = ensureInstalledPatches({ dshRoot: missing.root, log: silent });
	check(r.results.find((x) => x.package === "@deepseek-ai/dsh-subprocess-local").reason === "package-not-found", "missing package directory is reported, not guessed around");

	/* ---- ambiguous anchor refuses apply ---- */
	const ambiguousSource = PRISTINE_APIPROXY + '\nconst SECOND_ALLOWLIST = [\n\t"web-search-deepseek"\n];\n';
	const ambiguous = makeDshRoot(base, { apiproxySource: ambiguousSource });
	r = ensureInstalledPatches({ dshRoot: ambiguous.root, log: silent });
	const amb = r.results.find((x) => x.package === "@deepseek-ai/dsh-host-apiproxy");
	check(amb.ok === false && amb.reason === "ambiguous-anchor", "apply refuses when the anchor occurs twice");
	check(readFileSync(join(ambiguous.apiDir, "lib", "index.js"), "utf8") === ambiguousSource, "ambiguous-anchor file left untouched");

	/* ---- ambiguous marker refuses apply and restore ---- */
	const dup = makeDshRoot(base);
	writeFileSync(
		join(dup.apiDir, "lib", "index.js"),
		PRISTINE_APIPROXY.replace('\t"web-search-deepseek"\n];', '\t"web-search-deepseek",\n\t"keepalive", // dsh-keepalive: keep-alive watchdog configuration card\n];') +
			'\n// "keepalive", // dsh-keepalive legacy comment\n'
	);
	r = ensureInstalledPatches({ dshRoot: dup.root, log: silent });
	check(r.results.find((x) => x.package === "@deepseek-ai/dsh-host-apiproxy").reason === "ambiguous-marker", "apply refuses two markers");
	r = restoreInstalledPatches({ dshRoot: dup.root, log: silent });
	check(r.results.find((x) => x.package === "@deepseek-ai/dsh-host-apiproxy").reason === "ambiguous-marker", "restore refuses two markers");

	/* ---- restore fails loudly when the patched region changed ---- */
	const drifted = makeDshRoot(base);
	writeFileSync(
		join(drifted.apiDir, "lib", "index.js"),
		PRISTINE_APIPROXY.replace('\t"web-search-deepseek"\n];', '\t"web-search-deepseek",\n\t"keepalive", // dsh-keepalive: edited by someone else\n];')
	);
	r = restoreInstalledPatches({ dshRoot: drifted.root, log: silent });
	const drift = r.results.find((x) => x.package === "@deepseek-ai/dsh-host-apiproxy");
	check(drift.ok === false && drift.reason === "patch-region-changed", "restore refuses a non-canonical patched region");
	check(readFileSync(join(drifted.apiDir, "lib", "index.js"), "utf8").includes("edited by someone else"), "drifted file left untouched by restore");

	/* ---- atomic apply: syntax-check failure reverts the file ---- */
	const brokenSource = "const broken = ;\n" + PRISTINE_APIPROXY;
	const broken = makeDshRoot(base, { apiproxySource: brokenSource });
	r = ensureInstalledPatches({ dshRoot: broken.root, log: silent });
	const bad = r.results.find((x) => x.package === "@deepseek-ai/dsh-host-apiproxy");
	check(bad.ok === false && bad.reason === "syntax-check-failed", "apply fails when the patched file fails node --check");
	check(readFileSync(join(broken.apiDir, "lib", "index.js"), "utf8") === brokenSource, "syntax-check failure reverts the file to its previous bytes");

	/* ---- patch catalog sanity ---- */
	check(INSTALLED_PATCHES.length === 2, "exactly two patches are declared");
	check(INSTALLED_PATCHES.every((p) => p.marker.length > 0 && p.from.length > 0 && p.to.length > 0 && p.to.includes(p.marker)), "every patch declares a marker contained in its patched text");
} finally {
	rmSync(base, { recursive: true, force: true });
}

process.exit(done() ? 0 : 1);
