# dsh-keepalive

**Status: Feature Plugin with Compatibility Patch. Tested only with DeepSeek Harness 0.1.0-rc.6.**

`dsh-keepalive` runs a detached watchdog for the DSH Web process. When explicitly enabled, the watchdog restarts DSH after a process exit. An optional repair agent can inspect repeated startup failures, modify the plugin workspace, and retry from a snapshot.

## Problem

A Web process that exits cannot restart itself. DSH provides stream idle watchdogs and browser reconnect backoff, but those mechanisms do not supervise the host process.

## Behavior

- Adds a Plugins settings card for watchdog configuration.
- Starts a detached Node watchdog only when `enabled` is true.
- Checks process health and relaunches the same DSH binary and arguments.
- Applies guarded compatibility patches for the settings namespace and hidden Windows child processes.
- Optionally runs a repair agent after repeated boot failures.
- Snapshots the allowed repair workspace, validates resulting paths/configuration/syntax, and rolls back failed repairs.

Both `enabled` and `autoRepair` require explicit opt-in; automatic repair defaults to **false**.

## Non-goals

This package is not a high-availability cluster, service manager, sandbox, malware boundary, secret scrubber, or guarantee that a failed DSH instance can be repaired automatically. It does not replace systemd, Windows Service Control Manager, containers, or external monitoring.

## Compatibility patches

The plugin targets exactly:

- `@deepseek-ai/dsh-host-apiproxy@0.1.0-rc.6`: allow the `keepalive` settings namespace in the Web settings API.
- `@deepseek-ai/dsh-subprocess-local@0.1.0-rc.6`: use `windowsHide: true` for local tool subprocesses on Windows.

Version mismatch, missing anchors, or duplicate anchors refuse the operation. Writes use temporary files and rename, validate syntax after replacement, and restore the previous bytes on validation failure.

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
pnpm --dir ~/.dsh/profiles/web exec dsh-keepalive-uninstall
dsh plugin --profile web remove dsh-keepalive
```

The command disables keepalive state, terminates only the recorded watchdog process, and restores both patched official files. It exits nonzero if any step is incomplete. Normal Web shutdown does not reverse patches because shutdown is the event the watchdog supervises.

## Safety

The repair agent receives startup diagnostics as prompt input. Those diagnostics are untrusted and may contain misleading instructions. The repair runtime uses `workspace-write`, inherits environment information available to the launched process, and can modify the plugin workspace; this is not complete isolation or a confidentiality boundary. Snapshot, path, syntax, and rollback checks reduce accidental damage but do not make arbitrary agent output safe.

Review changes after every repair. Do not enable repair on a machine or plugin directory containing credentials that the repair process must not read.

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
