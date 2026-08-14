/**
 * helpers — shared fixture builders for the dsh-keepalive test suite.
 * Every fixture is self-contained (temp dirs, embedded pristine anchor
 * regions as literals); nothing here touches the real DSH install.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/* The exact official anchor regions of @deepseek-ai/dsh-host-apiproxy and
 * @deepseek-ai/dsh-subprocess-local @ 0.1.0-rc.6 (verified against the npm
 * tarballs). The files around them are minimal but syntactically valid ESM,
 * because the patch module runs `node --check` after every write. */
export const PRISTINE_APIPROXY = [
	"// @deepseek-ai/dsh-host-apiproxy@0.1.0-rc.6 fixture (pristine)",
	"const WEB_SETTINGS_NAMESPACES = [",
	'\t"agent-loop",',
	'\t"shell",',
	'\t"locale",',
	'\t"permission",',
	'\t"ui-conversation",',
	'\t"ui-theme",',
	'\t"web-search-deepseek"',
	"];",
	"export { WEB_SETTINGS_NAMESPACES };"
].join("\n") + "\n";

export const PRISTINE_SUBPROCESS = [
	"// @deepseek-ai/dsh-subprocess-local@0.1.0-rc.6 fixture (pristine)",
	"export function spawnSomething() {",
	"\tconst child = spawn(program, args, {",
	"\t\tcwd: spec.cwd,",
	"\t\tenv,",
	"\t\tstdio: [",
	'\t\t\tstdinMode === "ignore" ? "ignore" : "pipe",',
	'\t\t\toutMode === "inherit" ? "inherit" : "pipe",',
	'\t\t\terrMode === "inherit" ? "inherit" : "pipe"',
	"\t\t],",
	'\t\tdetached: platform !== "win32"',
	"\t});",
	"\treturn child;",
	"}"
].join("\n") + "\n";

export const FIXTURE_PKG_VERSION = "0.1.0-rc.6";

function pkgJson(name, version) {
	return JSON.stringify({ name, version, type: "module", main: "lib/index.js" }, null, 2) + "\n";
}

/** Build a fake DSH install root with the two patchable packages. */
export function makeDshRoot(base, { apiproxyVersion = FIXTURE_PKG_VERSION, subprocessVersion = FIXTURE_PKG_VERSION, apiproxySource = PRISTINE_APIPROXY, subprocessSource = PRISTINE_SUBPROCESS } = {}) {
	const root = join(base, "dsh-root");
	const apiDir = join(root, "node_modules", "@deepseek-ai", "dsh-host-apiproxy");
	const subDir = join(root, "node_modules", "@deepseek-ai", "dsh-subprocess-local");
	mkdirSync(join(apiDir, "lib"), { recursive: true });
	mkdirSync(join(subDir, "lib"), { recursive: true });
	writeFileSync(join(apiDir, "package.json"), pkgJson("@deepseek-ai/dsh-host-apiproxy", apiproxyVersion));
	writeFileSync(join(apiDir, "lib", "index.js"), apiproxySource);
	writeFileSync(join(subDir, "package.json"), pkgJson("@deepseek-ai/dsh-subprocess-local", subprocessVersion));
	writeFileSync(join(subDir, "lib", "index.js"), subprocessSource);
	/* the dsh bin.js whose dirname(dirname()) is the install root */
	const binDir = join(root, "lib");
	mkdirSync(binDir, { recursive: true });
	writeFileSync(join(binDir, "bin.js"), "#!/usr/bin/env node\n");
	return { root, bin: join(binDir, "bin.js"), apiDir, subDir };
}

/** Build a fake DSH_HOME with a plugins tree. */
export function makeHome(base) {
	const home = join(base, "home");
	mkdirSync(join(home, "plugins", "dsh-a"), { recursive: true });
	mkdirSync(join(home, "plugins", "dsh-b"), { recursive: true });
	mkdirSync(join(home, "profiles", "web"), { recursive: true });
	writeFileSync(join(home, "plugins", "dsh-a", "lib.js"), "export const a = 1;\n");
	writeFileSync(join(home, "plugins", "dsh-b", "index.mjs"), "export const b = 2;\n");
	writeFileSync(join(home, "settings.yaml"), "permission:\n  defaultPreset: danger-full-access\n");
	writeFileSync(join(home, "resume-state.json"), JSON.stringify({ version: 1, running: ["session-x"], subagents: [] }));
	writeFileSync(join(home, "profiles", "web", "cordis.patch.yml"), "plugins: []\n");
	return home;
}

/** Tiny assertion helpers with a shared failure counter. */
export function makeChecks(label) {
	let pass = 0;
	let fail = 0;
	const check = (cond, name) => {
		if (cond) {
			pass += 1;
			console.log(`PASS ${label}: ${name}`);
		} else {
			fail += 1;
			console.log(`FAIL ${label}: ${name}`);
		}
	};
	const done = () => {
		console.log(`${label}: ${pass} passed, ${fail} failed`);
		return fail === 0;
	};
	return { check, done };
}
