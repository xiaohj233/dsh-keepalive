# dsh-keepalive

[English](README.md) | 中文

**状态：功能插件（含兼容补丁），仅在 DeepSeek Harness 0.1.0-rc.6 上测试过。**

`dsh-keepalive` 为 DSH Web 进程运行一个分离的看门狗。显式启用后，看门狗会在进程退出后把 DSH 重新拉起来。可选的修复代理会检查反复出现的启动失败、修改插件工作区，并从快照重试。

## 问题

进程一旦退出，Web 自己无法重启。DSH 内置了流空闲看门狗和浏览器重连退避，但这些机制都不负责监督宿主进程。

## 行为

- 为看门狗配置添加一张 Plugins 设置卡片。
- 仅当 `enabled` 为 true 时启动分离的 Node 看门狗。
- 检查进程健康状态，用相同的 DSH 二进制和参数重新拉起。
- 手动重启：设置卡片「手动重启」按钮（或 `POST /api/keepalive/restart`）——当前进程退出后由看门狗拉起；看门狗未运行时由兜底重启器（`restarter.mjs`）以相同命令拉起。
- 为设置命名空间和 Windows 隐藏子进程应用守卫式兼容补丁。
- 启动反复失败后，可选地运行修复代理。
- 对允许修复的工作区做快照，校验结果路径/配置/语法，失败的修复回滚。
- 修复范围扩展：对 web profile 中 `link:`/`file:`（目录）依赖指向的开发目录，修复代理可在其 `node_modules` 下新增 junction 补齐依赖解析；新增链接被快照追踪、失败回滚时移除，现有条目与源码/配置一律不动。

`enabled` 和 `autoRepair` 都需要显式选择启用；自动修复默认 **false**。

## 非目标

本包不是高可用集群、服务管理器、沙箱、恶意软件边界或秘密清洗器，也不保证失败的 DSH 实例能被自动修复。它替代不了 systemd、Windows 服务控制管理器、容器或外部监控。

## 兼容补丁

本插件精确针对：

- `@deepseek-ai/dsh-host-apiproxy@0.1.0-rc.6`：允许 Web 设置 API 使用 `keepalive` 设置命名空间。
- `@deepseek-ai/dsh-subprocess-local@0.1.0-rc.6`：Windows 上本地工具子进程使用 `windowsHide: true`。

版本策略默认自适应：如果已安装副本的版本不是 `0.1.0-rc.6`，但每个锚点仍然唯一匹配，就照常打补丁（记为 adaptive 匹配）；锚点漂移则跳过并说明原因。编程选项 `strict` 可恢复"只打精确版本"的旧行为。单个漂移副本不会阻塞另一个目标，补丁应用在 host 或看门狗启动期间也绝不会抛错。设置命名空间这一行插在允许列表数组的顶部，避免占用与 `dsh-tavily-search-provider` 共享的尾部锚点——两个插件无论按什么顺序安装都能共存。还原（卸载）在任何模式下都严格校验版本。写入走临时文件加重命名的原子写入，替换后校验语法，校验失败则恢复原有字节。

## 兼容性

需要 DeepSeek Harness `0.1.0-rc.6`、Node.js `^22.19.0 || >=24`、pnpm `>=10`。看门狗针对当前 DSH CLI 的布局设计，已在 Windows 上测试。

## 安装

```sh
dsh plugin --profile web add "github:xiaohj233/dsh-keepalive#v0.1.0"
```

重启 Web profile。只安装并不会启用看门狗重启或修复。

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

provider、model、base URL、API 名称和凭据引用都以单行 YAML 安全字符串序列化。所选模型和凭据路径验证过之前，先保持修复禁用。

## 还原与卸载

从 profile 移除插件之前，先运行本包的卸载命令：

```sh
pnpm --dir "$DSH_HOME/profiles/web" exec dsh-keepalive-uninstall
dsh plugin --profile web remove dsh-keepalive
```

未设置 `$DSH_HOME` 时，profile 位于用户主目录下（POSIX 为 `~/.dsh/profiles/web`，Windows PowerShell 为 `%USERPROFILE%\.dsh\profiles\web`）；Windows 上请把解析后的路径传给 `pnpm --dir`，不要用 `~`。

命令会禁用 keepalive 状态、只终止记录的看门狗进程，并还原两个被打补丁的官方文件；任一步骤不完整都以非零状态退出。正常的 Web 关闭**不会**撤销补丁——关闭恰恰是看门狗要监督的事件。

## 安全

修复代理把启动诊断作为 prompt 输入接收。这些诊断不可信，可能夹带误导性的指令。修复运行时使用 `workspace-write`，继承启动进程可见的环境信息，可以修改插件工作区——这不是完整的隔离或保密边界。快照、路径、语法和回滚检查能减少意外损坏，但并不能让任意的 agent 输出变得安全。

每次修复后都要审查改动。不要在包含修复进程不该读取的凭据的机器或插件目录上启用修复。

其他已知限制：

- 看门狗监督和卸载只凭记录的 PID 识别看门狗。看门狗死后若该 PID 被无关进程复用，监督会静默失效，`dsh-keepalive-uninstall` 还可能终止那个无关进程。卸载前先确认看门狗是否在运行。
- 连续多次轮询无响应后，看门狗会强制终止监听所配置端口的任何进程（也就是预期的重启目标）；恰好占着该端口的无关服务也会被一并杀掉。
- 启动失败的诊断和最近一次修复代理的输出（上限 4 KB）会持久化在 keepalive 状态里，同源或受信任的页面可以从 `/api/keepalive/status` 读取。启动失败日志可能夹带环境中的秘密。
- 快照/差异/回滚层追踪 link 目标 node_modules 的顶层条目：修复代理在那里新增的 junction 会被发现并在回滚时移除；但普通插件工作区仍只遍历普通文件和目录，仍建议保持工作区无链接。
- Host 与看门狗都会重写 `keepalive.json`；并发写入可能暂时丢掉一次更新（下一次写入会自行纠正）。

## 测试

```sh
npm test
npm run check:syntax
npm pack --dry-run
```

测试覆盖：默认值、YAML 注入与往返、补丁/还原的精确行为、歧义锚点、语法回滚、快照、一次真实的分离进程卸载、看门狗启动，以及 `--unpatch` 参数约定。

## 局限性与上游现状

DSH 社区已有重启/自愈类插件，上游也可能推出官方的 keepalive 实现。本包只做一个对 Windows 友好的分离式看门狗，外加可选启用、带快照校验的修复。它无法从操作系统关机、账户注销、Node/DSH 二进制不可用或主机级资源耗尽中恢复。

## License

MIT。补丁目标均为 MIT 许可，详见 `THIRD_PARTY_NOTICES.md`。
