/**
 * repair-page tests: the zero-dependency status page served on the web port
 * while a repair runs. Verifies the JSON status API, the HTML page, phase and
 * progress flow, and that stop() releases the port.
 */

import { createRepairPage } from "../lib/repair-page.mjs";
import { makeChecks } from "./helpers.mjs";

const { check, done } = makeChecks("repair-page");
const PORT = 3199;
const logs = [];
const page = createRepairPage({ host: "127.0.0.1", port: PORT, log: (l) => logs.push(l) });

async function status() {
	const res = await fetch(`http://127.0.0.1:${PORT}/api/repair/status`);
	return res.json();
}

page.start();
await new Promise((r) => setTimeout(r, 250));

try {
	const s1 = await status();
	check(s1.phase === "detected", "initial phase is detected");
	check(typeof s1.elapsedMs === "number" && s1.timeoutMs === 900000, "status reports elapsed and timeout");

	page.set("agent-running");
	page.push("[agent] 已定位根因：缺少 raf 变量声明");
	page.push("[agent] 正在修改 client.js …");
	const s2 = await status();
	check(s2.phase === "agent-running", "phase transitions to agent-running");
	check(s2.progress.length === 2 && s2.progress[0].includes("raf"), "agent progress lines are surfaced");

	const html = await (await fetch(`http://127.0.0.1:${PORT}/`)).text();
	check(html.includes("DSH 正在修复") && html.includes("正在自动修复"), "page renders the Chinese repair title");
	check(html.includes("waitForWeb") && html.includes("/api/repair/status"), "page polls the status API and redirects on success");

	page.set("succeeded", { result: { ok: true } });
	const s3 = await status();
	check(s3.phase === "succeeded", "phase transitions to succeeded");

	page.stop();
	await new Promise((r) => setTimeout(r, 200));
	let refused = false;
	try {
		await fetch(`http://127.0.0.1:${PORT}/api/repair/status`, { signal: AbortSignal.timeout(1500) });
	} catch {
		refused = true;
	}
	check(refused, "stop() releases the port");
} finally {
	page.stop();
}

process.exit(done() ? 0 : 1);
