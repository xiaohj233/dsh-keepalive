/**
 * repair-page — the zero-dependency status page the watchdog serves on the
 * web port while a repair runs. Instead of "connection refused", the user
 * sees a live Chinese-language progress report (repair phase, agent stdout
 * stream, elapsed time) and is redirected back to the web UI when the repair
 * succeeds (or shown the failure summary when it does not).
 *
 * Pure Node built-ins only, so the watchdog can serve it even when dsh
 * itself cannot boot. The page is a status *display*: it holds no state that
 * the watchdog does not already own, and exposes only the current repair
 * attempt's progress.
 */

import http from "node:http";

export const REPAIR_TIMEOUT_MS = 900000;
export const PROGRESS_MAX = 120;

const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH 正在修复</title>
<style>
	body{margin:0;font-family:"Microsoft YaHei",system-ui,sans-serif;background:#0f1115;color:#e6e6e6;min-height:100vh;display:flex;align-items:center;justify-content:center}
	.card{max-width:760px;width:92%;background:#161a22;border:1px solid #2a3140;border-radius:14px;padding:28px 30px;box-shadow:0 8px 40px rgba(0,0,0,.5)}
	h1{font-size:20px;margin:0 0 6px;color:#ffb454}
	#phase{font-size:15px;color:#7fd1ff;margin:10px 0 4px}
	#meta{font-size:12px;color:#8b93a5;margin-bottom:12px}
	pre#progress{background:#0b0e13;border:1px solid #232a36;border-radius:8px;padding:12px;font-size:12px;line-height:1.55;max-height:320px;overflow:auto;white-space:pre-wrap;word-break:break-all;color:#c8d0dc;margin:0}
	#result{margin-top:14px;font-size:14px}
	.spin{display:inline-block;width:14px;height:14px;border:2px solid #ffb454;border-top-color:transparent;border-radius:50%;animation:sp 1s linear infinite;vertical-align:-2px;margin-right:8px}
	@keyframes sp{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="card">
	<h1>⚠ 启动发生错误，正在自动修复…</h1>
	<div id="phase">检测故障中</div>
	<div id="meta"></div>
	<pre id="progress"></pre>
	<div id="result"></div>
</div>
<script>
const PHASES = { detected:"检测故障", snapshot:"快照与审计", "agent-running":"修复代理执行中", verifying:"验证修复", relaunching:"正在重启服务", succeeded:"修复成功", failed:"修复失败" };
function pad(n){return String(n).padStart(2,"0")}
async function poll(){
	try{
		const r = await fetch("/api/repair/status", { cache:"no-store" });
		const s = await r.json();
		const sec = Math.floor((s.elapsedMs||0)/1000);
		document.getElementById("phase").textContent = (PHASES[s.phase]||s.phase);
		document.getElementById("meta").textContent = "已用时 " + Math.floor(sec/60) + ":" + pad(sec%60) + " / 最长 " + Math.floor((s.timeoutMs||900000)/60000) + " 分钟";
		document.getElementById("progress").textContent = (s.progress||[]).join("\\n");
		if (s.phase === "succeeded"){
			document.getElementById("result").innerHTML = "<span class='spin'></span>修复完成，正在启动界面…";
			waitForWeb();
			return;
		}
		if (s.phase === "failed"){
			const err = s.result && s.result.error ? s.result.error : "修复失败，请查看 keepalive.log";
			document.getElementById("result").innerHTML = "<b style='color:#ff6b6b'>✗ 修复失败</b><pre style='margin-top:8px;background:#1c1016;border:1px solid #4a222a;border-radius:8px;padding:10px;font-size:12px;white-space:pre-wrap;color:#f0a0a0'>" + err.replace(/&/g,"&amp;").replace(/</g,"&lt;") + "</pre>";
			return;
		}
	}catch(e){ /* page server still starting */ }
	setTimeout(poll, 2000);
}
async function waitForWeb(){
	try{
		const r = await fetch("/", { cache:"no-store" });
		if (r.ok){ location.href = "/"; return; }
	}catch(e){}
	setTimeout(waitForWeb, 2000);
}
poll();
</script>
</body>
</html>`;

/**
 * Create a repair status page controller bound to host:port.
 * Returns { start, stop, set, push, active }.
 */
export function createRepairPage({ host, port, log } = {}) {
	let page = null;

	function push(line) {
		if (!page) return;
		page.status.progress.push(line);
		if (page.status.progress.length > PROGRESS_MAX) page.status.progress.shift();
	}

	function set(phase, extra = {}) {
		if (!page) return;
		Object.assign(page.status, { phase, ...extra });
	}

	function start() {
		if (page) return page;
		const status = {
			phase: "detected",
			startedAt: Date.now(),
			progress: [],
			timeoutMs: REPAIR_TIMEOUT_MS,
			result: null
		};
		const server = http.createServer((req, res) => {
			const url = (req.url || "/").split("?")[0];
			if (url === "/api/repair/status") {
				res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({ ...status, elapsedMs: Date.now() - status.startedAt }));
				return;
			}
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(PAGE_HTML);
		});
		server.on("error", (error) => {
			if (log) log(`repair page bind failed (${error.code}) — skipping status page for this repair`);
			page = null;
		});
		server.listen(port, host, () => {
			if (log) log(`repair page up at http://${host}:${port}`);
		});
		page = { server, status };
		return page;
	}

	function stop() {
		if (!page) return;
		try {
			page.server.close();
		} catch {
			/* best-effort */
		}
		page = null;
	}

	function active() {
		return page !== null;
	}

	return { start, stop, set, push, active };
}
