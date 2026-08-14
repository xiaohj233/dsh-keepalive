# dsh-keepalive（看门狗守护与自修复）

**状态：功能插件（含兼容补丁，Feature Plugin with Compatibility Patch）。仅在 DeepSeek Harness（深度求索 Harness）0.1.0-rc.6 上测试过。**

`dsh-keepalive` 为 DSH Web 进程运行一个分离的（detached）看门狗（watchdog）。显式启用后，看门狗会在进程退出后重启 DSH。可选的修复代理（repair agent）可以检查反复出现的启动失败、修改插件工作区（workspace），并从快照（snapshot）重试。

## 问题

退出的 Web 进程无法自行重启。DSH 提供了流空闲看门狗和浏览器重连退避（reconnect backoff），但这些机制并不监督主机进程（host process）。

## 行为

- 添加一个用于看门狗配置的 Plugins 设置卡片。
- 仅当 `enabled` 为 true 时才启动分离的 Node 看门狗。
- 检查进程健康状态，并用相同的 DSH 二进制与参数重新启动。
- 为设置命名空间（settings namespace）和 Windows 隐藏子进程应用受保护（guarded）的兼容补丁。
- 启动反复失败后，可选地运行修复代理。
- 对允许修复的工作区做快照，校验结果路径/配置/语法，并回滚（rollback）失败的修复。

`enabled` 和 `autoRepair` 都需要显式选择启用；自动修复默认值为 **false**。

## 非目标

本包不是高可用集群、服务管理器、沙箱（sandbox）、恶意软件边界、秘密清洗器（secret scrubber），也不保证失败的 DSH 实例能自动修复。它不能替代 systemd、Windows 服务控制管理器（Service Control Manager）、容器或外部监控。

## 兼容补丁

本插件精确针对：

- `@deepseek-ai/dsh-host-apiproxy@0.1.0-rc.6`：允许在 Web 设置 API 中使用 `keepalive` 设置命名空间。
- `@deepseek-ai/dsh-subprocess-local@0.1.0-rc.6`：在 Windows 上为本地工具子进程使用 `windowsHide: true`。

版本策略默认是自适应（adaptive）的：当已安装副本的版本与 `0.1.0-rc.6` 不同，但每个锚点仍然唯一匹配时，仍会打补丁（记录为 adaptive 匹配）；锚点漂移时则以原因跳过；严格的编程模式可恢复旧的"仅精确版本"应用行为。单个漂移副本永远不会阻塞另一个目标，补丁应用在 host 或 watchdog 启动期间也绝不会抛错。还原（卸载）在所有模式下都保持严格的版本守卫。写入使用临时文件和重命名（atomic write，原子写入），替换后校验语法，校验失败时恢复之前的字节。

## 兼容性

需要 DeepSeek Harness `0.1.0-rc.6`、Node.js `^22.19.0 || >=24` 和 pnpm `>=10`。看门狗针对当前的 DSH CLI 布局设计，并已在 Windows 上测试。

## 安装

```sh
dsh plugin --profile web add "github:xiaohj233/dsh-keepalive#v0.1.0"
```

重启 Web profile。仅安装不会启用看门狗重启或修复功能。

## 配置

通过 Plugins 卡片或设置文件配置 `keepalive` 设置区块：

```yaml
keepalive:
  enabled: false
  autoRepair: false
  checkIntervalMs: 3000
  bootWaitMs: 15000
  repairProvider: ""
  repairModel: ""
```

Provider、model、base URL、API 名称和凭据引用（credential-reference）值都以单行 YAML 安全字符串序列化。在所选模型和凭据路径经过测试之前，请保持修复功能处于禁用状态。

## 显式卸载与还原

在从 profile 中移除之前，**先**运行本包的卸载命令：

```sh
pnpm --dir "$DSH_HOME/profiles/web" exec dsh-keepalive-uninstall
dsh plugin --profile web remove dsh-keepalive
```

当 `$DSH_HOME` 未设置时，profile 位于主目录下（POSIX：`~/.dsh/profiles/web`；Windows PowerShell：`%USERPROFILE%\.dsh\profiles\web`）；在 Windows 上，请将解析后的路径传给 `pnpm --dir`，而不是 `~`。

该命令会禁用 keepalive 状态、只终止已记录的看门狗进程，并还原两个被打补丁的官方文件。任何步骤未完成时，命令会以非零状态退出。正常的 Web 关闭不会撤销补丁，因为关闭正是看门狗要监督的事件。

## 安全

修复代理会把启动诊断信息作为 prompt 输入接收。这些诊断信息不可信（untrusted），可能包含误导性的指令。修复运行时使用 `workspace-write`，继承启动进程可用的环境信息，并且可以修改插件工作区；这并非完整的隔离或保密边界。快照、路径、语法和回滚检查能减少意外损坏，但并不能让任意 agent 输出变得安全。

每次修复后都要审查改动。不要在与修复进程不应读取的凭据共存的机器或插件目录上启用修复。

其他已知局限性：

- 看门狗监督和卸载仅通过记录的 PID 识别看门狗。如果看门狗死亡后该 PID 被无关进程复用，监督会静默停止，`dsh-keepalive-uninstall` 可能终止那个无关进程。卸载前请检查是否有看门狗在运行。
- 连续多次轮询未响应后，看门狗会强制终止监听所配置端口的任何进程（即预期的重新启动目标）。占用该端口的无关服务也会被杀死。
- 启动失败的诊断信息和最近一次修复代理的输出（最多 4 KB）会持久化在 keepalive 状态中，同源或受信任的页面可以从 `/api/keepalive/status` 读取。启动失败的日志可能嵌入来自环境的秘密。
- 快照/差异（diff）/回滚层遍历常规文件和目录；被攻陷的修复代理放置在插件工作区内的 junction 或符号链接（symlink）可以把写入重定向到快照范围之外而不被发现。
- Host 和看门狗都会重写 `keepalive.json`；并发写入可能暂时丢失一次更新（下次写入时会自我纠正）。

## 测试

```sh
npm test
npm run check:syntax
npm pack --dry-run
```

该套件覆盖：默认值、YAML 注入/往返、精确的补丁/还原行为、歧义锚点、语法回滚、快照、一次真实的分离进程卸载、看门狗启动，以及 `--unpatch` 参数约定。

## 局限性

DSH 社区中已存在重启/自愈（self-healing）插件，上游也可能会加入官方的 keepalive 实现。本包的范围是一个对 Windows 友好的分离式看门狗，附带可选启用、带快照校验的修复。它无法从操作系统关机、账户注销、Node/DSH 二进制不可用或主机级资源耗尽中恢复。

## License

MIT。补丁目标均为 MIT 许可；参见 `THIRD_PARTY_NOTICES.md`。
