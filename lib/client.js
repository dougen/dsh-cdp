// dsh-cdp — browser half.
//
// A browser icon in the composer's trailing control row, immediately left of
// the capability-panel button, plus a status panel anchored to it.
//
// Both are ordinary slot entries: the composer exposes
// `conversation.input.right` for "compact controls before the composer submit
// action", and the capability panel occupies it at order 1000, so a lower order
// places this icon directly beside it. No DOM injection is involved.
//
// The panel anchors under the icon and flips above it when the space below is
// too small — which is the normal case here, because the composer sits at the
// bottom of the viewport. It has no backdrop, so it never dims or blocks the
// app.
//
// Status comes from one side-effect-free `/api/dsh-cdp?cmd=status` poll.
// `status` never attaches to the browser, so polling it cannot raise the
// remote-debugging prompt.
//
// The same poll carries `busy`, which the host raises while a browser command
// runs and holds briefly afterwards. It paints the icon blue and outranks the
// connection-state colour: green says "attached", blue says "in use right now".
//
// Styling uses `--dsw-*` theme variables with literal fallbacks, because those
// variables are defined in component scope rather than on the document root.
window.__ModuleLoader__.load({
	id: "dsh-cdp",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const { useState, useEffect, useLayoutEffect, useCallback, useRef } = react;
		const h = react.createElement;

		// ---- constants --------------------------------------------------
		const ROUTE = "/api/dsh-cdp";
		const STATUS_PATH = ROUTE + "?cmd=status";
		const NS = "dsh-cdp";
		/**
		 * Poll cadence while the icon is mounted but the panel is closed.
		 *
		 * Kept well under the host's activity hold window (5s): the icon learns
		 * about a browser command only from this poll, so a slower cadence than
		 * the hold would let the whole "agent is driving the browser" state pass
		 * between two samples.
		 */
		const POLL_MS = 2000;
		/** Poll cadence while the panel is open (it shows live durations). */
		const POLL_OPEN_MS = 1000;
		const PANEL_WIDTH = 272;
		/** Gap between the icon and the panel. */
		const ANCHOR_GAP = 6;
		/** Smallest distance the panel keeps from the viewport edges. */
		const VIEWPORT_MARGIN = 8;
		/**
		 * The capability panel's order in this slot. Sitting just below it keeps
		 * this icon adjacent to (and left of) that button while leaving room for
		 * other entries between.
		 */
		const CAPABILITY_PANEL_ORDER = 1000;
		const OUR_ORDER = 900;
		/** Panel height assumed before the real one is measured. */
		const PANEL_HEIGHT_FALLBACK = 260;
		/**
		 * Marks the composer icon so the panel's outside-press handler can tell
		 * a press on the anchor from a press anywhere else.
		 */
		const ICON_ATTR = "data-dsh-cdp-icon";

		// ---- i18n -------------------------------------------------------
		const ZH = {
			"title": "浏览器连接",
			"icon.label": "浏览器连接",
			"icon.active": "正在操作浏览器",
			"state.idle": "尚未连接",
			"state.disconnected": "未连接",
			"state.connecting": "连接中",
			"state.awaiting-approval": "等待授权",
			"state.connected": "已连接",
			"state.error": "连接失败",
			"field.auth": "授权状态",
			"field.uptime": "连接时长",
			"field.heartbeat": "最近心跳",
			"field.endpoint": "端点",
			"field.browser": "浏览器",
			"auth.yes": "已授权",
			"auth.no": "未授权",
			"auth.pending": "待授权",
			"auth.detail": "一次授权后，连接保持期间不再弹出询问。",
			"hint.idle": "尚未连接浏览器。首次调用浏览器功能时才会请求授权。",
			"hint.awaiting-approval": "请切换到浏览器窗口，点击远程调试提示中的「允许」。",
			"hint.disconnected": "未检测到已开启调试端口的浏览器。在浏览器中打开 chrome://inspect 并勾选允许远程调试，或用下列命令启动：",
			"hint.error": "连接失败，正在自动重试。",
			"copy": "复制",
			"copied": "已复制",
			"refresh": "刷新",
			"close": "关闭",
			"connect": "连接浏览器",
			"retry": "立即重试",
			"never": "—",
			"duration.seconds": "{s}秒",
			"duration.minutes": "{m}分{s}秒",
			"duration.hours": "{h}小时{m}分",
		};
		const EN = {
			"title": "Browser connection",
			"icon.label": "Browser connection",
			"icon.active": "Operating the browser",
			"state.idle": "Not connected yet",
			"state.disconnected": "Not connected",
			"state.connecting": "Connecting",
			"state.awaiting-approval": "Awaiting approval",
			"state.connected": "Connected",
			"state.error": "Connection failed",
			"field.auth": "Authorization",
			"field.uptime": "Connected for",
			"field.heartbeat": "Last heartbeat",
			"field.endpoint": "Endpoint",
			"field.browser": "Browser",
			"auth.yes": "Authorized",
			"auth.no": "Not authorized",
			"auth.pending": "Pending",
			"auth.detail": "One approval covers the connection until it drops.",
			"hint.idle": "No browser attached yet. Authorization is requested the first time a browser feature is used.",
			"hint.awaiting-approval": "Switch to the browser window and click Allow on the remote debugging prompt.",
			"hint.disconnected": "No browser with a debug endpoint was found. Open chrome://inspect in the browser and enable remote debugging, or launch it with:",
			"hint.error": "Connection failed; retrying automatically.",
			"copy": "Copy",
			"copied": "Copied",
			"refresh": "Refresh",
			"close": "Close",
			"connect": "Connect browser",
			"retry": "Retry now",
			"never": "—",
			"duration.seconds": "{s}s",
			"duration.minutes": "{m}m {s}s",
			"duration.hours": "{h}h {m}m",
		};

		// Literal fallbacks matter: the --dsw-* variables resolve in component
		// scope, so a value read at the wrong node comes back empty.
		const C = {
			ok: "var(--dsw-alias-state-success-primary, rgb(52,168,83))",
			warn: "var(--dsw-alias-state-warn-primary, rgb(230,140,0))",
			err: "var(--dsw-alias-state-error-primary, rgb(217,48,37))",
			// The framework's informational accent (the same token its info tags
			// use), for "in use" rather than "connected".
			active: "var(--dsw-alias-state-business-primary, rgb(65,118,230))",
			// Matches the neighbouring composer controls' resting colour.
			icon: "var(--dsw-alias-label-secondary, rgb(97,102,107))",
			muted: "var(--dsw-alias-label-tertiary, rgb(129,133,140))",
			label: "var(--dsw-alias-label-primary, rgb(31,35,41))",
			sub: "var(--dsw-alias-label-secondary, rgb(97,102,107))",
			border: "var(--dsw-alias-border-l1, rgba(0,0,0,.12))",
			layer: "var(--dsw-alias-bg-layer-1, #ffffff)",
			hover: "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06))",
			subtle: "var(--dsw-alias-bg-layer-2, rgba(0,0,0,.035))",
		};

		/** Icon/indicator colour for a connection state. */
		function stateColor(state) {
			if (state === "connected") return C.ok;
			if (state === "connecting" || state === "awaiting-approval") return C.warn;
			if (state === "error") return C.err;
			return C.icon;
		}

		/**
		 * Colour of the composer icon.
		 *
		 * Activity outranks connection state: while the agent is driving the
		 * browser the icon is blue regardless of whether that leaves the
		 * connection green, amber, or red, because "something is happening now"
		 * is the more specific fact and the panel still carries the state colour
		 * in its own dot.
		 *
		 * Pure, so the precedence is unit-testable without a reconciler.
		 */
		function iconColor(status) {
			if (status && status.busy === true) return C.active;
			return stateColor(status && status.state ? status.state : "idle");
		}

		/**
		 * Decide where the panel goes for a given icon and viewport.
		 *
		 * Below by default, flipped above when the remaining space underneath
		 * cannot hold the panel — the composer sits at the bottom of the
		 * viewport, so the flip is the common case rather than an edge case.
		 * Horizontally the panel right-aligns to the icon (this slot lives in
		 * the trailing group) and is then clamped inside the viewport.
		 *
		 * Pure, so the placement rules are unit-testable without a reconciler.
		 *
		 * @returns `{ top, left, placement }` in viewport coordinates.
		 */
		function computePanelPosition(icon, panelHeight, panelWidth, viewportWidth, viewportHeight) {
			const height = panelHeight > 0 ? panelHeight : PANEL_HEIGHT_FALLBACK;
			const spaceBelow = viewportHeight - icon.bottom - ANCHOR_GAP - VIEWPORT_MARGIN;
			const fitsBelow = spaceBelow >= height;
			const top = fitsBelow
				? icon.bottom + ANCHOR_GAP
				: Math.max(VIEWPORT_MARGIN, icon.top - ANCHOR_GAP - height);

			// Right-align to the icon, then clamp into the viewport.
			let left = (icon.right !== undefined ? icon.right : icon.left + 28) - panelWidth;
			const maxLeft = viewportWidth - panelWidth - VIEWPORT_MARGIN;
			if (left > maxLeft) left = maxLeft;
			if (left < VIEWPORT_MARGIN) left = VIEWPORT_MARGIN;

			return { top: Math.round(top), left: Math.round(left), placement: fitsBelow ? 'below' : 'above' };
		}

		// ---- shared store -----------------------------------------------
		// One poll feeds both halves; module scope because the loader gives each
		// bundle a single instance.
		const store = {
			status: null,
			/** Whether the composer icon is currently mounted. */
			mounted: false,
			open: false,
			rect: null,
			listeners: new Set(),
			timer: null,
			subscribe(fn) {
				this.listeners.add(fn);
				return () => this.listeners.delete(fn);
			},
			emit() {
				for (const fn of [...this.listeners]) {
					try { fn(this.status); } catch (e) { /* one bad listener must not stop the rest */ }
				}
			},
			setStatus(next) {
				this.status = next;
				this.emit();
			},
			interval() {
				return this.open ? POLL_OPEN_MS : POLL_MS;
			},
			/** Poll while anything is visible; stop when nothing is. */
			sync() {
				const wanted = this.mounted || this.open;
				if (wanted && this.timer === null) {
					this.refresh();
					this.timer = setInterval(() => this.refresh(), this.interval());
				} else if (!wanted && this.timer !== null) {
					clearInterval(this.timer);
					this.timer = null;
				} else if (wanted && this.timer !== null) {
					// Cadence changed (panel opened/closed): restart the timer.
					clearInterval(this.timer);
					this.timer = setInterval(() => this.refresh(), this.interval());
				}
			},
			async refresh() {
				try {
					const res = await fetch(STATUS_PATH, { cache: "no-store" });
					const body = await res.json();
					this.setStatus(body && body.status ? body.status : null);
				} catch (e) {
					// Keep the last known status; one failed poll is not a change.
				}
			},
			stop() {
				if (this.timer !== null) clearInterval(this.timer);
				this.timer = null;
			},
		};

		// ---- i18n hook ---------------------------------------------------
		/**
		 * Language to use when the locale service is unreachable: the shell keeps
		 * `<html lang>` in sync with the active locale, so it is the right ambient
		 * source. Anything that is not Chinese resolves to English, matching the
		 * framework's own fallback locale.
		 */
		function ambientLang() {
			try {
				const tag =
					(typeof document !== "undefined" && document.documentElement ? document.documentElement.lang : "") ||
					(typeof navigator !== "undefined" ? navigator.language : "") ||
					"";
				return /^zh\b/i.test(tag) ? "zh" : "en";
			} catch (e) {
				return "en";
			}
		}
		/** Stable snapshot for the no-locale-service case (uSES compares by identity). */
		const AMBIENT = Object.freeze({ active: ambientLang() });

		/** Milliseconds since an epoch timestamp, or null when there is none. */
		function ageMs(timestamp, now) {
			return typeof timestamp === "number" && Number.isFinite(timestamp) ? now - timestamp : null;
		}

		/**
		 * Render a duration from milliseconds in the active language.
		 *
		 * The host's own `connectedFor`/`lastHeartbeatAgo` strings use
		 * language-neutral `s`/`m`/`h` units; formatting here keeps the panel
		 * consistent with the rest of the shell, which spells the units out in
		 * the active locale.
		 *
		 * @returns the formatted duration, or null when there is no duration.
		 */
		function formatDuration(ms, t) {
			if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
			const totalSeconds = Math.floor(ms / 1000);
			if (totalSeconds < 60) return t("duration.seconds", { s: totalSeconds });
			const minutes = Math.floor(totalSeconds / 60);
			if (minutes < 60) {
				return t("duration.minutes", { m: minutes, s: totalSeconds % 60 });
			}
			return t("duration.hours", { h: Math.floor(minutes / 60), m: minutes % 60 });
		}

		function useLocale(ctx) {
			const locale = ctx && ctx.locale;
			const snap = react.useSyncExternalStore(
				(cb) => (locale && typeof locale.subscribe === "function" ? locale.subscribe(cb) : () => {}),
				() => (locale && typeof locale.getSnapshot === "function" ? locale.getSnapshot() : AMBIENT),
			);
			const lang = snap && snap.active === "en" ? "en" : "zh";
			const bound = locale && typeof locale.bind === "function" ? locale.bind(NS) : null;
			const t = useCallback(
				(key, params) => {
					try {
						if (bound) {
							const v = bound(key, params);
							if (typeof v === "string" && v !== key) return v;
						}
					} catch (e) { /* fall through to the bundled dictionary */ }
					let text = (lang === "en" ? EN : ZH)[key] || key;
					if (params) {
						for (const name of Object.keys(params)) {
							text = text.split("{" + name + "}").join(String(params[name]));
						}
					}
					return text;
				},
				[bound, lang],
			);
			return { t, lang };
		}

		// ---- icon --------------------------------------------------------
		/** A frameless browser window: the app's other composer glyphs are 14px outlines. */
		function BrowserGlyph() {
			return h("svg", {
				width: 14, height: 14, viewBox: "0 0 16 16", fill: "none",
				"aria-hidden": "true", style: { display: "block" },
			},
				h("rect", { x: 1.6, y: 2.6, width: 12.8, height: 10.8, rx: 2.2, stroke: "currentColor", strokeWidth: 1.3 }),
				h("path", { d: "M1.6 5.9h12.8", stroke: "currentColor", strokeWidth: 1.3 }),
				h("circle", { cx: 3.7, cy: 4.25, r: 0.62, fill: "currentColor" }),
				h("circle", { cx: 5.7, cy: 4.25, r: 0.62, fill: "currentColor" }));
		}

		function openPanel(rect) {
			store.rect = rect;
			store.open = true;
			store.emit();
			store.sync();
		}
		function closePanel() {
			store.open = false;
			store.emit();
			store.sync();
		}

		/**
		 * The composer control. It owns no panel markup: it reports its rect to
		 * the store and the overlay renders the panel, so the panel is not
		 * clipped by the composer's own overflow.
		 */
		function ComposerButton(props) {
			const ctx = props.ctx;
			const { t } = useLocale(ctx);
			const [, setRevision] = useState(0);
			const ref = useRef(null);

			useEffect(() => {
				store.mounted = true;
				store.sync();
				const unsubscribe = store.subscribe(() => setRevision((n) => n + 1));
				return () => {
					unsubscribe();
					store.mounted = false;
					// The panel cannot stay open without its anchor.
					if (store.open) closePanel();
					store.sync();
				};
			}, []);

			const state = store.status && store.status.state ? store.status.state : "idle";
			const busy = !!(store.status && store.status.busy === true);
			// The accessible name carries the same distinction as the colour, so
			// activity is not signalled by hue alone.
			const label = busy
				? t("icon.active")
				: t("icon.label") + " · " + t("state." + state);

			const readRect = () => {
				const el = ref.current;
				if (!el || typeof el.getBoundingClientRect !== "function") return null;
				const r = el.getBoundingClientRect();
				return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
			};

			return h("button", {
				ref: ref,
				type: "button",
				[ICON_ATTR]: "",
				"aria-haspopup": "dialog",
				"aria-expanded": store.open ? "true" : "false",
				"aria-label": label,
				title: label,
				onClick: (event) => {
					event.preventDefault();
					if (store.open) {
						closePanel();
						return;
					}
					openPanel(readRect());
				},
				style: {
					// Matches the neighbouring 28px round composer controls.
					boxSizing: "border-box", width: 28, height: 28, padding: 0,
					display: "grid", placeItems: "center",
					border: "none", borderRadius: 999, background: "transparent",
					cursor: "pointer", flex: "none",
					color: iconColor(store.status),
					transition: "color .12s ease, background-color .12s ease",
				},
				onMouseEnter: (e) => { e.currentTarget.style.background = C.hover; },
				onMouseLeave: (e) => { e.currentTarget.style.background = "transparent"; },
			}, h(BrowserGlyph, null));
		}

		// ---- panel (React, anchored) -------------------------------------
		function StatusPanel(props) {
			const ctx = props.ctx;
			const { t } = useLocale(ctx);
			// A revision counter: every store change (status, open, rect) bumps it,
			// so render reads the store directly and can never mix fields from two
			// different updates.
			const [, setRevision] = useState(0);
			const [copied, setCopied] = useState(false);
			const [command, setCommand] = useState("");
			const [panelHeight, setPanelHeight] = useState(0);
			const panelRef = useRef(null);

			useEffect(
				() => store.subscribe(() => setRevision((n) => n + 1)),
				[],
			);

			const status = store.status;
			const open = store.open;
			const rect = store.rect;
			const state = status && status.state ? status.state : "idle";

			// Measure before paint so the panel never flashes at the wrong edge.
			useLayoutEffect(() => {
				if (!open) return;
				const el = panelRef.current;
				if (!el || typeof el.getBoundingClientRect !== "function") return;
				const measured = Math.round(el.getBoundingClientRect().height);
				if (measured > 0 && measured !== panelHeight) setPanelHeight(measured);
			});

			useEffect(() => {
				if (!open) return undefined;
				// Close on an outside press or Escape. Listening in the capture
				// phase closes before the page handles the click — which is why
				// the icon is excluded explicitly: otherwise pressing the icon to
				// close would close here and then reopen on its own click.
				const onDown = (e) => {
					const panel = panelRef.current;
					if (panel && panel.contains(e.target)) return;
					if (e.target && typeof e.target.closest === "function" && e.target.closest("[" + ICON_ATTR + "]")) return;
					closePanel();
				};
				const onKey = (e) => { if (e.key === "Escape") closePanel(); };
				document.addEventListener("mousedown", onDown, true);
				document.addEventListener("keydown", onKey);
				return () => {
					document.removeEventListener("mousedown", onDown, true);
					document.removeEventListener("keydown", onKey);
				};
			}, [open]);

			// The launch hint is only useful when nothing was found; fetch it
			// lazily so the common case costs no extra request.
			useEffect(() => {
				if (!open || state !== "disconnected" || command !== "") return undefined;
				let cancelled = false;
				(async () => {
					try {
						const res = await fetch(ROUTE + "?cmd=browsers", { cache: "no-store" });
						const body = await res.json();
						const rows = Array.isArray(body && body.browsers) ? body.browsers : [];
						const hit = rows.find((r) => r.launch);
						if (!cancelled && hit) setCommand(hit.launch);
					} catch (e) { /* the hint is optional */ }
				})();
				return () => { cancelled = true; };
			}, [open, state, command]);

			const act = useCallback(async (cmd) => {
				try {
					await fetch(ROUTE + "?cmd=" + cmd, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ cmd: cmd }),
					});
				} catch (e) { /* the next poll reflects the outcome */ }
				store.refresh();
			}, []);

			// A closed panel renders nothing at all — no DOM, no listeners.
			if (!open) return null;

			const authorized = !!(status && status.authorized);
			const browser = (status && status.browser) || t("never");
			const endpoint = (status && status.endpoint) || t("never");
			// Durations are derived here rather than read from the host's
			// preformatted `connectedFor`/`lastHeartbeatAgo`: the payload already
			// carries both timestamps, and only the client knows the panel's
			// language. The open panel re-polls every few seconds, so this stays
			// current.
			const now = Date.now();
			const uptime = formatDuration(ageMs(status && status.connectedAt, now), t) || t("never");
			const heartbeat = formatDuration(ageMs(status && status.lastHeartbeatAt, now), t) || t("never");
			const authText = authorized
				? t("auth.yes")
				: state === "awaiting-approval"
					? t("auth.pending")
					: t("auth.no");
			const authColor = authorized ? C.ok : state === "awaiting-approval" ? C.warn : C.sub;

			const viewportWidth = typeof window !== "undefined" && window.innerWidth ? window.innerWidth : 1024;
			const viewportHeight = typeof window !== "undefined" && window.innerHeight ? window.innerHeight : 768;
			const anchor = rect || { top: viewportHeight - 120, bottom: viewportHeight - 90, left: viewportWidth - 320, right: viewportWidth - 292 };
			const pos = computePanelPosition(anchor, panelHeight, PANEL_WIDTH, viewportWidth, viewportHeight);

			const Row = (label, value, color) =>
				h("div", { style: { display: "flex", alignItems: "baseline", gap: 10, padding: "4px 0", fontSize: 12, lineHeight: "17px" } },
					h("span", { style: { flex: "none", width: 76, color: C.sub } }, label),
					h("span", { style: { flex: 1, minWidth: 0, color: color || C.label, fontWeight: 600, overflowWrap: "anywhere" } }, value));

			const hint =
				state === "idle" ? t("hint.idle")
				: state === "awaiting-approval" ? t("hint.awaiting-approval")
				: state === "disconnected" ? t("hint.disconnected")
				: state === "error" ? t("hint.error")
				: "";

			return h("div", {
				ref: panelRef,
				role: "dialog",
				"aria-label": t("title"),
				"data-placement": pos.placement,
				// Anchored to the icon. No backdrop: the panel must not dim or
				// block the rest of the app.
				style: {
					position: "fixed", top: pos.top, left: pos.left, width: PANEL_WIDTH,
					boxSizing: "border-box", zIndex: 40,
					pointerEvents: "auto",
					borderRadius: 10, border: "1px solid " + C.border,
					background: C.layer, color: C.label,
					boxShadow: "0 6px 20px rgba(0,0,0,.16), 0 1px 3px rgba(0,0,0,.10)",
					padding: 12,
					font: "inherit", fontSize: 12,
				},
			},
				h("div", { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 8 } },
					h("span", { style: { width: 7, height: 7, borderRadius: "50%", flex: "none", background: stateColor(state) } }),
					h("span", { style: { flex: 1, fontWeight: 700, fontSize: 12.5 } }, t("state." + state)),
					h("button", {
						type: "button", title: t("refresh"),
						onClick: () => store.refresh(),
						style: { cursor: "pointer", flex: "none", border: "none", background: "transparent", color: C.sub, borderRadius: 6, padding: "1px 4px", font: "inherit", fontSize: 12, lineHeight: "18px" },
					}, "⟳"),
					h("button", {
						type: "button", title: t("close"),
						onClick: () => closePanel(),
						style: { cursor: "pointer", flex: "none", border: "none", background: "transparent", color: C.sub, borderRadius: 6, padding: "1px 4px", font: "inherit", fontSize: 12, lineHeight: "18px" },
					}, "✕")),

				h("div", null,
					Row(t("field.browser"), browser),
					Row(t("field.endpoint"), endpoint),
					Row(t("field.auth"), authText, authColor),
					Row(t("field.uptime"), uptime),
					Row(t("field.heartbeat"), heartbeat)),

				authorized ? h("div", { style: { color: C.sub, fontSize: 10.5, marginTop: 2 } }, t("auth.detail")) : null,

				hint
					? h("div", {
							style: { marginTop: 9, padding: "7px 9px", borderRadius: 7, background: C.subtle, color: C.sub, fontSize: 11, lineHeight: "16px" },
						},
						h("div", null, hint),
						command
							? h("div", { style: { marginTop: 6, display: "flex", gap: 5, alignItems: "flex-start" } },
									h("code", {
										style: {
											flex: 1, minWidth: 0, display: "block", fontFamily: "monospace", fontSize: 10,
											color: C.label, background: C.layer, border: "1px solid " + C.border,
											borderRadius: 5, padding: "4px 5px", overflowWrap: "anywhere", userSelect: "all",
										},
									}, command),
									h("button", {
										type: "button",
										onClick: async () => {
											try {
												await navigator.clipboard.writeText(command);
												setCopied(true);
												setTimeout(() => setCopied(false), 1500);
											} catch (e) { /* clipboard may be unavailable */ }
										},
										style: { cursor: "pointer", flex: "none", border: "1px solid " + C.border, background: "transparent", color: C.sub, borderRadius: 5, padding: "3px 6px", font: "inherit", fontSize: 10.5 },
									}, copied ? t("copied") : t("copy")))
							: null)
					: null,

				(state === "idle" || state === "error" || state === "disconnected")
					? h("div", { style: { marginTop: 9 } },
							h("button", {
								type: "button",
								onClick: () => act(state === "idle" ? "connect" : "reconnect"),
								style: { cursor: "pointer", border: "1px solid " + C.border, background: "transparent", color: C.label, borderRadius: 6, padding: "4px 9px", font: "inherit", fontSize: 11.5 },
							}, state === "idle" ? t("connect") : t("retry")))
					: null,
			);
		}


		// ---- plugin body --------------------------------------------------
		const inject = ["slots", "locale"];

		function apply(ctx) {
			try {
				if (ctx.locale && typeof ctx.locale.register === "function") {
					ctx.locale.register(NS, { zh: ZH, en: EN });
				}
			} catch (e) { /* components fall back to the bundled dictionary */ }

			// The icon lives in the composer's trailing controls, beside the
			// capability panel. The composer owns overflow clipping, so the panel
			// is rendered by the overlay instead of inside this row.
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register(
				{ name: "conversation.input.right", id: "dsh-cdp", order: OUR_ORDER, label: "浏览器连接" },
				() => h(ComposerButton, { ctx }),
			));

			ctx.slots.inject("shell.overlay", () => ctx.slots.register(
				{ name: "shell.overlay", id: "dsh-cdp-panel", order: 90, label: "浏览器连接面板" },
				() => h(StatusPanel, { ctx }),
			));

			ctx.effect(() => () => {
				store.stop();
				store.mounted = false;
				store.open = false;
			}, "dsh-cdp: store");
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.__test = {
			store: store,
			computePanelPosition: computePanelPosition,
			stateColor: stateColor,
			iconColor: iconColor,
			CAPABILITY_PANEL_ORDER: CAPABILITY_PANEL_ORDER,
			OUR_ORDER: OUR_ORDER,
		};
		return module.exports;
	},
});
