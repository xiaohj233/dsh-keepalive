/*!
 * dsh-keepalive — client bundle.
 *
 * Renders the keep-alive configuration card inside the official
 * Settings → Plugins page (the "可配置" tab), registering into the same
 * `settings.plugin.item` slot the official bash / agent-loop / web-search
 * cards use. Visual language is the official plugin-card language: the CSS
 * class names of `@deepseek-ai/dsh-client-ui-settings-plugins` (whose bundle
 * is always loaded with the web app) are reused, and the card form model is
 * the same staged-save CardForm those cards use, bound to the `keepalive:`
 * settings namespace.
 *
 * Fields (settings.yaml `keepalive:` section):
 *   enabled          — keep-alive master switch
 *   autoRepair       — call dsh's own agent to repair failed launches
 *   repairProvider   — provider for the repair agent ("" = follow the
 *                      conversation default model)
 *   repairModel      — model for the repair agent
 *   checkIntervalMs  — watchdog poll interval (ms)
 *   bootWaitMs       — time to wait for the port after a relaunch (ms)
 *
 * Bundle contract: classic script registering via `window.__ModuleLoader__`
 * with the factory-form CJS shape used by the framework's own client bundles.
 */
window.__ModuleLoader__.load({
	id: "dsh-keepalive",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");
		var jsxRuntime = require("react/jsx-runtime");
		var clientRuntime = require("@deepseek-ai/dsh-client-runtime/client");
		var primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		/* Official settings-plugins CSS hashes — those bundles are always
		 * loaded, so these class names are guaranteed to be styled. */
		var F = {
			field: "At1oFq_field",
			head: "At1oFq_head",
			label: "At1oFq_label",
			badges: "At1oFq_badges",
			badge: "At1oFq_badge",
			badgeMuted: "At1oFq_badgeMuted",
			reset: "At1oFq_reset",
			input: "At1oFq_input",
			inputInvalid: "At1oFq_inputInvalid",
			invalid: "At1oFq_invalid",
			hint: "At1oFq_hint"
		};
		var C = {
			card: "YyYd_a_card",
			cardOpen: "YyYd_a_cardOpen",
			header: "YyYd_a_header",
			headText: "YyYd_a_headText",
			name: "YyYd_a_name",
			description: "YyYd_a_description",
			chevron: "YyYd_a_chevron",
			chevronOpen: "YyYd_a_chevronOpen",
			body: "YyYd_a_body",
			readOnly: "YyYd_a_readOnly",
			pending: "YyYd_a_pending",
			footer: "YyYd_a_footer",
			failed: "YyYd_a_failed",
			discard: "YyYd_a_discard",
			save: "YyYd_a_save"
		};
		var TOKENS = {
			labelPrimary: "var(--dsw-alias-label-primary)",
			labelSecondary: "var(--dsw-alias-label-secondary)",
			labelTertiary: "var(--dsw-alias-label-tertiary)",
			bgLayer3: "var(--dsw-alias-bg-layer-3)",
			bgPlatform: "var(--dsw-alias-bg-module-platform)",
			borderL2: "var(--dsw-alias-border-l2)",
			success: "var(--dsw-alias-state-success-primary)",
			error: "var(--dsw-alias-label-error)",
			knob: "var(--dsw-alias-button-contrast-fill)",
			font: "var(--dsw-font-family, system-ui, sans-serif)",
			ease: "var(--ds-ease-in-out, cubic-bezier(0.4,0,0.2,1))",
			duration: "var(--ds-transition-duration, 0.2s)"
		};

		/* ---------------------------------------------------------- fields */
		/**
		 * Official-style staged value field (same markup as the settings-plugins
		 * ValueField): label, overridden badge + reset, input, hint.
		 */
		function ValueField(props) {
			return jsxRuntime.jsxs("div", {
				className: F.field,
				children: [
					jsxRuntime.jsxs("div", {
						className: F.head,
						children: [
							jsxRuntime.jsx("label", { className: F.label, htmlFor: props.id, children: props.label }),
							props.overridden
								? jsxRuntime.jsxs("span", {
									className: F.badges,
									children: [
										jsxRuntime.jsx("span", { className: F.badge, children: props.overriddenLabel }),
										jsxRuntime.jsx("button", {
											type: "button",
											className: F.reset,
											disabled: props.disabled,
											onClick: props.onReset,
											children: props.resetLabel
										})
									]
								})
								: null
						]
					}),
					jsxRuntime.jsx("input", {
						id: props.id,
						className: props.invalid ? F.inputInvalid : F.input,
						type: "text",
						...(props.numeric === true ? { inputMode: "numeric" } : {}),
						...(props.invalid ? { "aria-invalid": true } : {}),
						value: props.text,
						placeholder: props.placeholder ?? "",
						disabled: props.disabled,
						onChange: function (event) { props.onEdit(event.target.value); }
					}),
					jsxRuntime.jsx("p", {
						className: props.invalid ? F.invalid : F.hint,
						children: props.invalid ? props.invalidLabel : props.hint
					})
				]
			});
		}

		/**
		 * Official-style boolean toggle field. The switch itself is drawn with
		 * DSH alias tokens to match the platform's native switches.
		 */
		function ToggleField(props) {
			var on = props.text === "true";
			return jsxRuntime.jsxs("div", {
				className: F.field,
				children: [
					jsxRuntime.jsxs("div", {
						className: F.head,
						children: [
							jsxRuntime.jsx("label", { className: F.label, htmlFor: props.id, children: props.label }),
							props.overridden
								? jsxRuntime.jsxs("span", {
									className: F.badges,
									children: [
										jsxRuntime.jsx("span", { className: F.badge, children: props.overriddenLabel }),
										jsxRuntime.jsx("button", {
											type: "button",
											className: F.reset,
											disabled: props.disabled,
											onClick: props.onReset,
											children: props.resetLabel
										})
									]
								})
								: null
						]
					}),
					jsxRuntime.jsx("button", {
						type: "button",
						role: "switch",
						id: props.id,
						"aria-checked": on ? "true" : "false",
						disabled: props.disabled,
						onClick: function () { props.onEdit(on ? "false" : "true"); },
						style: {
							position: "relative",
							display: "inline-block",
							width: 36,
							height: 20,
							borderRadius: 999,
							border: 0,
							cursor: props.disabled ? "default" : "pointer",
							background: on ? TOKENS.success : TOKENS.bgPlatform,
							boxShadow: "inset 0 0 0 1px " + TOKENS.borderL2,
							transition: "background " + TOKENS.duration + " " + TOKENS.ease
						},
						children: jsxRuntime.jsx("span", {
							style: {
								position: "absolute",
								top: 2,
								left: 2,
								width: 16,
								height: 16,
								borderRadius: "50%",
								background: TOKENS.knob,
								boxShadow: "0 1px 2px rgba(0,0,0,.3)",
								transform: on ? "translateX(16px)" : "translateX(0)",
								transition: "transform " + TOKENS.duration + " " + TOKENS.ease
							}
						})
					}),
					jsxRuntime.jsx("p", { className: F.hint, children: props.hint })
				]
			});
		}

		/**
		 * Official-style select field: label, staged text, overridden badge +
		 * reset, a native select styled with the official input tokens.
		 * @param props - { id, label, hint, options[], value, disabled, onEdit }
		 */
		function SelectField(props) {
			return jsxRuntime.jsxs("div", {
				className: F.field,
				children: [
					jsxRuntime.jsxs("div", {
						className: F.head,
						children: [
							jsxRuntime.jsx("label", { className: F.label, htmlFor: props.id, children: props.label }),
							props.overridden
								? jsxRuntime.jsxs("span", {
									className: F.badges,
									children: [
										jsxRuntime.jsx("span", { className: F.badge, children: props.overriddenLabel }),
										jsxRuntime.jsx("button", {
											type: "button",
											className: F.reset,
											disabled: props.disabled,
											onClick: props.onReset,
											children: props.resetLabel
										})
									]
								})
								: null
						]
					}),
					jsxRuntime.jsx("select", {
						id: props.id,
						value: props.value,
						disabled: props.disabled,
						onChange: function (event) { props.onEdit(event.target.value); },
						style: {
							appearance: "none",
							border: "1px solid " + TOKENS.borderL2,
							background: TOKENS.bgLayer3,
							height: 34,
							font: "inherit",
							color: TOKENS.labelPrimary,
							borderRadius: 8,
							padding: "0 30px 0 12px",
							fontSize: 13,
							lineHeight: 1.5,
							cursor: "pointer",
							backgroundImage: "linear-gradient(45deg, transparent 50%, " + TOKENS.labelSecondary + " 50%), linear-gradient(135deg, " + TOKENS.labelSecondary + " 50%, transparent 50%)",
							backgroundPosition: "calc(100% - 15px) 13px, calc(100% - 10px) 13px",
							backgroundSize: "5px 5px, 5px 5px",
							backgroundRepeat: "no-repeat"
						},
						children: props.options.map(function (option) {
							return jsxRuntime.jsx("option", { value: option.value, children: option.label }, option.value);
						})
					}),
					jsxRuntime.jsx("p", { className: F.hint, children: props.hint })
				]
			});
		}

		/* ------------------------------------------------------ card form */
		/* The staged form model, identical to the official plugin cards:
		 * nothing writes until save; a field shows its effective value and
		 * whether the user layer carries it. */
		function numberField(field) {
			return {
				field,
				format: (value) => typeof value === "number" ? String(value) : "",
				parse: (text) => {
					const trimmed = text.trim();
					if (trimmed === "") return { kind: "clear" };
					const parsed = Number(trimmed);
					return Number.isFinite(parsed) ? { kind: "set", value: parsed } : void 0;
				}
			};
		}

		function textField(field) {
			return {
				field,
				format: (value) => typeof value === "string" ? value : "",
				parse: (text) => {
					const trimmed = text.trim();
					return trimmed === "" ? { kind: "clear" } : { kind: "set", value: trimmed };
				}
			};
		}

		function booleanField(field) {
			return {
				field,
				format: (value) => value === true ? "true" : "false",
				parse: (text) => {
					const trimmed = text.trim();
					if (trimmed === "true") return { kind: "set", value: true };
					if (trimmed === "false") return { kind: "set", value: false };
					return void 0;
				}
			};
		}

		var CardForm = class {
			constructor(scope, specs) {
				this.scope = scope;
				this.specs = new Map(specs.map((spec) => [spec.field, spec]));
				this.staged = new Map();
				this.listeners = new Set();
				this.saving = false;
				this.failed = false;
				scope.subscribe(() => { this.publish(); });
			}
			bind(project) {
				const store = clientRuntime.createSnapshotStore(project());
				this.listeners.add(() => { store.set(project()); });
				return store;
			}
			shell() {
				const snapshot = this.scope.getSnapshot();
				const plan = this.plan();
				return {
					available: snapshot.status === "ready",
					writable: snapshot.writable,
					dirty: plan.length > 0,
					invalid: plan.some((item) => item.run === void 0),
					saving: this.saving,
					failed: this.failed
				};
			}
			field(field) {
				const staged = this.staged.get(field);
				const spec = this.spec(field);
				if (staged === void 0) return {
					text: spec.format(this.sectionValue(field)),
					overridden: this.stored(field),
					invalid: false
				};
				const write = staged.clear ? { kind: "clear" } : spec.parse(staged.text);
				return {
					text: staged.text,
					overridden: write?.kind === "set",
					invalid: write === void 0
				};
			}
			actions() {
				return {
					edit: (field, text) => { this.stage(field, { text, clear: false }); },
					resetField: (field) => { this.stage(field, { text: this.spec(field).format(this.baseValue(field)), clear: true }); },
					save: () => { this.save(); },
					discard: () => {
						if (this.staged.size === 0 && !this.failed) return;
						this.staged.clear();
						this.failed = false;
						this.publish();
					}
				};
			}
			async save() {
				const plan = this.plan();
				const writes = plan.flatMap((item) => item.run === void 0 ? [] : [item.run]);
				if (plan.length === 0 || this.saving || writes.length !== plan.length) return;
				this.saving = true;
				this.failed = false;
				this.publish();
				let landed = true;
				for (const write of writes) landed = await write() && landed;
				if (landed) this.staged.clear();
				this.saving = false;
				this.failed = !landed;
				this.publish();
			}
			plan() {
				const plan = [];
				for (const [field, staged] of this.staged) {
					const spec = this.spec(field);
					if (staged.clear) {
						if (this.stored(field)) plan.push({ field, run: () => this.clear(field) });
						continue;
					}
					if (staged.text === spec.format(this.sectionValue(field))) continue;
					const write = spec.parse(staged.text);
					if (write === void 0) plan.push({ field, run: void 0 });
					else if (write.kind === "clear") plan.push({ field, run: () => this.clear(field) });
					else plan.push({ field, run: () => this.store(field, write.value) });
				}
				return plan;
			}
			async clear(field) {
				await this.scope.unset(field);
				return !this.stored(field);
			}
			async store(field, value) {
				await this.scope.set(field, value);
				return this.userLayer()?.[field] === value;
			}
			stage(field, edit) {
				this.staged.set(field, edit);
				this.failed = false;
				this.publish();
			}
			spec(field) {
				const spec = this.specs.get(field);
				if (spec === void 0) throw new Error(`keepalive card has no field ${field}`);
				return spec;
			}
			snapshotOf() {
				return this.scope.getSnapshot();
			}
			sectionValue(field) {
				return this.snapshotOf().value?.[field];
			}
			baseValue(field) {
				return this.snapshotOf().base?.[field];
			}
			userLayer() {
				return this.snapshotOf().user;
			}
			stored(field) {
				const user = this.userLayer();
				return user !== void 0 && Object.hasOwn(user, field);
			}
			publish() {
				for (const listener of this.listeners) listener();
			}
		};

		/* ------------------------------------------------------ the card */
		/** Official-style collapsible plugin card (same chrome as the
		 * settings-plugins PluginCard; an unavailable namespace renders
		 * nothing, exactly like the official cards). */
		function PluginCard(props) {
			var openState = react.useState(false);
			var open = openState[0];
			var setOpen = openState[1];
			if (!props.state.available) return null;
			return jsxRuntime.jsxs("li", {
				className: C.card + (open ? " " + C.cardOpen : ""),
				children: [
					jsxRuntime.jsx("button", {
						type: "button",
						className: C.header,
						"aria-expanded": open ? "true" : "false",
						onClick: function () { setOpen(!open); },
						children: [
							jsxRuntime.jsxs("span", {
								className: C.headText,
								children: [
									jsxRuntime.jsx("span", { className: C.name, children: props.title }),
									jsxRuntime.jsx("span", { className: C.description, children: props.description })
								]
							}),
							props.state.dirty
								? jsxRuntime.jsx("span", { className: C.pending, children: "未保存的更改" })
								: null,
							jsxRuntime.jsx(primitives.IconChevronDownOutline14, {
								className: C.chevron + (open ? " " + C.chevronOpen : "")
							})
						]
					}),
					open
						? jsxRuntime.jsxs(react.Fragment, {
							children: [
								props.state.writable === false
									? jsxRuntime.jsx("p", { className: C.readOnly, children: "配置只读，无法修改" })
									: null,
								jsxRuntime.jsx("div", { className: C.body, children: props.children }),
								jsxRuntime.jsxs("div", {
									className: C.footer,
									children: [
										props.state.failed
											? jsxRuntime.jsx("p", { className: C.failed, children: "保存失败，请重试" })
											: null,
										props.action ? props.action : null,
										jsxRuntime.jsx("button", {
											type: "button",
											className: C.discard,
											disabled: !props.state.dirty,
											onClick: props.onDiscard,
											children: "放弃"
										}),
										jsxRuntime.jsx("button", {
											type: "button",
											className: C.save,
											disabled: !props.state.dirty || props.state.invalid || props.state.saving,
											onClick: props.onSave,
											children: props.state.saving ? "保存中…" : "保存"
										})
									]
								})
							]
						})
						: null
				]
			});
		}

		/** The keep-alive configuration card. */
		function KeepaliveCard(props) {
			var state = props.useKeepaliveCard(function (snapshot) { return snapshot; });
			var providersState = react.useState([]);
			var providers = providersState[0];
			var setProviders = providersState[1];

			react.useEffect(function () {
				var alive = true;
				fetch("/api/keepalive/status", { cache: "no-store" })
					.then(function (res) { return res.ok ? res.json() : null; })
					.then(function (payload) {
						if (alive && payload !== null) setProviders(payload.providers ?? []);
					})
					.catch(function () { /* provider list is decorative */ });
				return function () { alive = false; };
			}, []);

			var restartingState = react.useState(false);
			var restarting = restartingState[0];
			var setRestarting = restartingState[1];

			/** 手动重启：确认后请求 host 退出；看门狗（或兜底重启器）以相同
			 * 命令拉起，页面随后由下方 webPid 轮询自动刷新。 */
			function requestRestart() {
				if (restarting) return;
				if (!window.confirm("确定手动重启 DSH Web 吗？当前会话会保存，页面将在重启后自动刷新。")) return;
				setRestarting(true);
				fetch("/api/keepalive/restart", { method: "POST", cache: "no-store" })
					.then(function (res) { return res.json(); })
					.then(function (payload) {
						if (payload === null || payload.ok !== true) {
							setRestarting(false);
							window.alert("重启请求失败：" + (payload && payload.error ? payload.error : "未知错误"));
						}
						/* ok：页面会经 webPid 轮询自动 reload */
					})
					.catch(function () {
						setRestarting(false);
						window.alert("重启请求失败：网络错误");
					});
			}

			var disabled = !state.writable;
			var selectedProvider = state.repairProvider.text;
			var providerModels = [];
			for (var i = 0; i < providers.length; i += 1) {
				if (providers[i].name === selectedProvider) providerModels = providers[i].models ?? [];
			}

			/* 官方次按钮样式（C.discard），放在卡片 footer，与「放弃/保存」同排 */
			var restartButton = jsxRuntime.jsx("button", {
				type: "button",
				className: C.discard,
				title: "立即重启 DSH Web 进程：看门狗（或兜底重启器）会以相同命令重新拉起，页面随后自动刷新",
				disabled: restarting,
				onClick: function () { requestRestart(); },
				children: restarting ? "正在重启…" : "手动重启"
			});

			return jsxRuntime.jsx(PluginCard, {
				title: "保活",
				description: "DSH 被关闭或崩溃后自动拉起；拉起失败时由 DSH 自身的 agent 修复（仅限插件目录并带快照回滚）",
				state: state,
				onSave: props.save,
				onDiscard: props.discard,
				action: restartButton,
				children: [
					jsxRuntime.jsx(ToggleField, {
						id: "keepalive-enabled",
						label: "保活",
						hint: "开启后，DSH 被关闭或崩溃会被自动重新拉起",
						overriddenLabel: "已覆盖",
						resetLabel: "恢复默认",
						disabled: disabled,
						...state.enabled,
						onEdit: function (text) { props.edit("enabled", text); },
						onReset: function () { props.resetField("enabled"); }
					}),
					jsxRuntime.jsx(ToggleField, {
						id: "keepalive-autorepair",
						label: "自动修复",
						hint: "拉起失败时调用 DSH 的 agent 根据报错修复（仅限插件目录；修复失败则停止等待手动处理）",
						overriddenLabel: "已覆盖",
						resetLabel: "恢复默认",
						disabled: disabled,
						...state.autoRepair,
						onEdit: function (text) { props.edit("autoRepair", text); },
						onReset: function () { props.resetField("autoRepair"); }
					}),
					jsxRuntime.jsx(SelectField, {
						id: "keepalive-repair-provider",
						label: "修复厂商",
						hint: "修复 agent 使用哪个厂商（留空跟随对话默认模型）",
						overriddenLabel: "已覆盖",
						resetLabel: "恢复默认",
						disabled: disabled,
						value: state.repairProvider.text,
						options: [{ value: "", label: "跟随对话默认" }].concat(providers.map(function (p) {
							return { value: p.name, label: p.name };
						})),
						onEdit: function (text) { props.edit("repairProvider", text); },
						onReset: function () { props.resetField("repairProvider"); }
					}),
					jsxRuntime.jsx(SelectField, {
						id: "keepalive-repair-model",
						label: "修复模型",
						hint: "修复 agent 使用的模型（留空跟随厂商默认）",
						overriddenLabel: "已覆盖",
						resetLabel: "恢复默认",
						disabled: disabled,
						value: state.repairModel.text,
						options: [{ value: "", label: "厂商默认" }].concat(providerModels.map(function (m) {
							return { value: m, label: m };
						})),
						onEdit: function (text) { props.edit("repairModel", text); },
						onReset: function () { props.resetField("repairModel"); }
					}),
					jsxRuntime.jsx(ValueField, {
						id: "keepalive-check-interval",
						label: "检查间隔（毫秒）",
						hint: "watchdog 检查 web 存活状态的间隔",
						overriddenLabel: "已覆盖",
						resetLabel: "恢复默认",
						invalidLabel: "需要整数",
						numeric: true,
						disabled: disabled,
						...state.checkIntervalMs,
						onEdit: function (text) { props.edit("checkIntervalMs", text); },
						onReset: function () { props.resetField("checkIntervalMs"); }
					}),
					jsxRuntime.jsx(ValueField, {
						id: "keepalive-boot-wait",
						label: "启动等待（毫秒）",
						hint: "拉起后等待 HTTP 就绪的超时时间",
						overriddenLabel: "已覆盖",
						resetLabel: "恢复默认",
						invalidLabel: "需要整数",
						numeric: true,
						disabled: disabled,
						...state.bootWaitMs,
						onEdit: function (text) { props.edit("bootWaitMs", text); },
						onReset: function () { props.resetField("bootWaitMs"); }
					})
				]
			});
		}

		/* ---------------------------------------------------- controller */
		var KeepaliveCardController = class {
			constructor(scope) {
				this.form = new CardForm(scope, [
					booleanField("enabled"),
					booleanField("autoRepair"),
					textField("repairProvider"),
					textField("repairModel"),
					numberField("checkIntervalMs"),
					numberField("bootWaitMs")
				]);
				this.store = this.form.bind(() => this.projection());
			}
			projection() {
				return {
					...this.form.shell(),
					enabled: this.form.field("enabled"),
					autoRepair: this.form.field("autoRepair"),
					repairProvider: this.form.field("repairProvider"),
					repairModel: this.form.field("repairModel"),
					checkIntervalMs: this.form.field("checkIntervalMs"),
					bootWaitMs: this.form.field("bootWaitMs")
				};
			}
			inject() {
				return {
					hooks: { keepaliveCard: this.store },
					...this.form.actions()
				};
			}
		};

		/** Mount the card into the official Settings → Plugins page. */
		function apply(ctx) {
			var controller = new KeepaliveCardController(ctx.settingsScope.bind({ namespace: "keepalive" }));
			ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
				name: "settings.plugin.item",
				id: "keepalive",
				order: 30,
				inject: () => controller.inject()
			}, KeepaliveCard));

			/* 自动刷新：watchdog 重启 web 后，浏览器页面自动 reload，避免停留在
			 * 已死进程的页面上。轮询 /api/keepalive/status：webPid 变化 → reload；
			 * 连续 3 次请求失败（旧进程已退出）→ reload。 */
			ctx.effect(() => {
				var recorded = null;
				var fails = 0;
				function tick() {
					fetch("/api/keepalive/status", { cache: "no-store" })
						.then(function (res) { return res.ok ? res.json() : null; })
						.then(function (payload) {
							if (payload === null || typeof payload.webPid !== "number") return;
							fails = 0;
							if (recorded === null) {
								recorded = payload.webPid;
								return;
							}
							if (payload.webPid !== recorded) window.location.reload();
						})
						.catch(function () {
							fails += 1;
							if (fails >= 3) window.location.reload();
						});
				}
				tick();
				var timer = setInterval(tick, 3000);
				return function () { clearInterval(timer); };
			}, "dsh-keepalive: auto reload on web restart");
		}

		exports.name = "dsh-keepalive";
		exports.inject = ["slots", "settingsScope"];
		exports.apply = apply;
		return module.exports;
	}
});
