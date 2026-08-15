# dsh-keepalive

English | [中文](README.zh.md)

**Status: Feature Plugin with Compatibility Patch. Tested only with DeepSeek Harness 0.1.0-rc.6.**

`dsh-keepalive` runs a detached watchdog for the DSH Web process. When explicitly enabled, the watchdog restarts DSH after a process exit. An optional repair agent can inspect repeated startup failures, modify the plugin workspace, and retry from a snapshot.

## Problem

A Web process that exits cannot restart itself. DSH provides stream idle watchdogs and browser reconnect backoff, but those mechanisms do not supervise the host process.

## Behavior

- Adds a Plugins settings card for watchdog configuration.
- Starts a detached Node watchdog only when `enabled` is true.
- Checks process health and relaunches the same DSH binary and arguments.
- Manual restart: the card's "手动重启" button (or `POST /api/keepalive/restart`) — the current process exits and the watchdog relaunches it; when no watchdog is running, the fallback restarter (`restarter.mjs`) relaunches with the same binary and arguments.
- Applies guarded compatibility patches for the settings namespace and hidden Windows child processes.
- Optionally runs a repair agent after repeated boot failures.
- Snapshots the allowed repair workspace, validates resulting paths/configuration/syntax, and rolls back failed repairs.
- Repair scope extension: for dev checkouts referenced by `link:`/`file:` (directory) dependencies in the web profile, the repair agent may add junctions under their `node_modules` to resolve dependencies; added junctions are snapshot-tracked and removed on failed-rollback, while existing entries and source/config are never touched.
- Repair status page: when a web launch fails and a repair begins, the watchdog serves a zero-dependency status page on the web port (default 3080) — "startup failed, repairing", live repair-agent progress and elapsed time; on success the page auto-redirects back to the web UI, on failure it shows the agent's conclusion.
- The repair agent may make minimal source fixes inside the dev-checkout root that owns the failing plugin (e.g. add a missing variable declaration, fix an import, repair syntax); that root is content-snapshotted and rolled back on failure; file deletion is forbidden.
- The repair agent's workspace root is automatically the common parent of all user dev-checkout targets (e.g. `D:\Code`); official `@deepseek-ai/*` link packages are excluded and never writable; writes are bounded by the snapshot audit.
- Front-end plugin failure reporting: when the web is UP but a client plugin fails to load in the browser (e.g. a module-top-level `raf is not defined`), the keepalive client watches window errors and reports them; the watchdog runs a "degraded repair" (skips live dirs in the snapshot, relaunches web to reload plugins afterwards).
- Global repair progress banner: a fixed banner in any page's corner shows "正在修复: phase + agent progress lines" live; it renders only while `status=repairing`, disappears when the repair finishes, and shows the failure reason on error.

Both `enabled` and `autoRepair` require explicit opt-in; automatic repair defaults to **false**.

## Non-goals

This package is not a high-availability cluster, service manager, sandbox, malware boundary, secret scrubber, or guarantee that a failed DSH instance can be repaired automatically. It does not replace systemd, Windows Service Control Manager, containers, or external monitoring.

## Compatibility patches

The plugin targets exactly:

- `@deepseek-ai/dsh-host-apiproxy@0.1.0-rc.6`: allow the `keepalive` settings namespace in the Web settings API.
- `@deepseek-ai/dsh-subprocess-local@0.1.0-rc.6`: use `windowsHide: true` for local tool subprocesses on Windows.

Version policy is adaptive by default: a copy whose installed version differs from `0.1.0-rc.6` is still patched when every anchor matches uniquely (recorded as an adaptive match), and skipped with a reason when anchors drifted; a strict programmatic mode restores the old exact-version-only apply behavior. One drifted copy never blocks the other target, and patch application never throws during host or watchdog startup. The settings-namespace row is inserted at the top of the allowlist array so it cannot consume the tail anchor shared with `dsh-tavily-search-provider`; both plugins coexist in either install order. Restore (uninstall) remains strictly version-guarded. Writes use temporary files and rename, validate syntax after replacement, and restore the previous bytes on validation failure.

## Compatibility

Requires DeepSeek Harness `0.1.0-rc.6`, Node.js `^22.19.0 || >=24`, and pnpm `>=10`. The watchdog is designed for the current DSH CLI layout and is tested on Windows.

## Install

```sh
dsh plugin --profile web add "github:xiaohj233/dsh-keepalive#v0.1.0"
```

Restart the Web profile. Installation alone does not enable watchdog restart or repair.

## Configuration

Configure the `keepalive` settings section through the Plugins card or settings file:

```yaml
keepalive:
  enabled: false
  autoRepair: false
  checkIntervalMs: 3000
  bootWaitMs: 15000
  repairProvider: ""
  repairModel: ""
```

Provider, model, base URL, API name, and credential-reference values are serialized as single-line YAML-safe strings. Keep repair disabled until the selected model and credential path have been tested.

## Explicit uninstall and restore

Run the package's uninstall command **before** removing it from the profile:

```sh
pnpm --dir "$DSH_HOME/profiles/web" exec dsh-keepalive-uninstall
dsh plugin --profile web remove dsh-keepalive
```

When `$DSH_HOME` is unset the profile lives under the home directory (POSIX: `~/.dsh/profiles/web`; Windows PowerShell: `%USERPROFILE%\.dsh\profiles\web`); on Windows pass the resolved path to `pnpm --dir` instead of `~`.

The command disables keepalive state, terminates only the recorded watchdog process, and restores both patched official files. It exits nonzero if any step is incomplete. Normal Web shutdown does not reverse patches because shutdown is the event the watchdog supervises.

## Safety

The repair agent receives startup diagnostics as prompt input. Those diagnostics are untrusted and may contain misleading instructions. The repair runtime uses `workspace-write`, inherits environment information available to the launched process, and can modify the plugin workspace; this is not complete isolation or a confidentiality boundary. Snapshot, path, syntax, and rollback checks reduce accidental damage but do not make arbitrary agent output safe.

Review changes after every repair. Do not enable repair on a machine or plugin directory containing credentials that the repair process must not read.

Additional known limitations:

- Watchdog supervision and uninstall identify the watchdog only by recorded PID. If that PID was reused by an unrelated process after the watchdog died, supervision stops silently and `dsh-keepalive-uninstall` can terminate the unrelated process. Check for a running watchdog before uninstalling.
- After repeated missed polls, the watchdog force-terminates whatever process listens on the configured port (the intended relaunch target). An unrelated service holding that port is killed too.
- Failed-launch diagnostics and the last repair-agent output (up to 4 KB) are persisted in keepalive state and can be read from `/api/keepalive/status` by a same-origin or trusted page. Failed-launch logs may embed secrets from the environment.
- The snapshot/diff/rollback layer tracks the top-level entries of link-target `node_modules`: junctions the repair agent adds there are detected and removed on rollback; plain plugin workspaces are still walked as regular files and directories, so keep them link-free.
- Host and watchdog both rewrite `keepalive.json`; a concurrent write can transiently lose one update (self-corrects on the next write).

## Tests

```sh
npm test
npm run check:syntax
npm pack --dry-run
```

The suite covers defaults, YAML injection/round trips, exact patch/restore behavior, ambiguous anchors, syntax rollback, snapshots, a real detached-process uninstall, watchdog startup, and the `--unpatch` argument contract.

## Limitations and upstream status

Restart/self-healing plugins already exist in the DSH community, and upstream may add an official keepalive implementation. This package is scoped to a Windows-friendly detached watchdog with opt-in snapshot-checked repair. It cannot recover from OS shutdown, account logout, unavailable Node/DSH binaries, or host-level resource exhaustion.

## License

MIT. Patch targets are MIT-licensed; see `THIRD_PARTY_NOTICES.md`.
