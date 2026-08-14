/**
 * check-syntax — run `node --check` over every .js/.mjs file in the package
 * (excluding node_modules and .git), so a broken file can never ship.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const EXCLUDE_DIRS = new Set(["node_modules", ".git"]);
const files = [];

function walk(dir) {
	for (const name of readdirSync(dir)) {
		if (EXCLUDE_DIRS.has(name)) continue;
		const full = join(dir, name);
		const st = statSync(full);
		if (st.isDirectory()) walk(full);
		else if (st.isFile() && /\.(js|mjs)$/.test(name)) files.push(full);
	}
}
walk(root);

let failed = 0;
for (const file of files) {
	const res = spawnSync(process.execPath, ["--check", file], {
		encoding: "utf8",
		timeout: 30000,
		windowsHide: true
	});
	if (res.status !== 0) {
		failed += 1;
		console.error(`SYNTAX FAIL ${file}: ${(res.stderr ?? "").trim()}`);
	}
}
console.log(`check-syntax: ${files.length - failed}/${files.length} files parse cleanly`);
process.exit(failed === 0 ? 0 : 1);
