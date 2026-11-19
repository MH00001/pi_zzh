// Live progress display while the read-only planner prepares a plan.
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type KeybindingsManager,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { WorkflowPlan } from "./workflow.ts";

export type WorkflowPlanningEvent =
	| { kind: "starting" }
	| { kind: "tool"; name: string }
	| { kind: "turn"; count: number }
	| { kind: "thinking"; delta: string };

type PlanningOutcome =
	| { kind: "ready"; plan: WorkflowPlan }
	| { kind: "cancelled" }
	| { kind: "error"; error: unknown };

/** Show planning activity immediately and return only after the planner finishes or is cancelled. */
export async function showWorkflowPlanning(
	goal: string,
	ctx: ExtensionContext,
	run: (signal: AbortSignal, onProgress: (event: WorkflowPlanningEvent) => void) => Promise<WorkflowPlan>,
): Promise<WorkflowPlan | undefined> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("正在生成计划…", "info");
		return run(new AbortController().signal, () => {});
	}
	const controller = new AbortController();
	const outcome = await ctx.ui.custom<PlanningOutcome>(
		(tui, theme, keybindings, done) => {
			const view = new PlanningProgressView(tui, theme, keybindings, goal, () => controller.abort());
			// Defer the model call until the overlay has been mounted and rendered once.
			setTimeout(() => {
				if (controller.signal.aborted) {
					done({ kind: "cancelled" });
					return;
				}
				void run(controller.signal, (event) => view.update(event)).then(
					(plan) => done(controller.signal.aborted ? { kind: "cancelled" } : { kind: "ready", plan }),
					(error: unknown) => done(controller.signal.aborted ? { kind: "cancelled" } : { kind: "error", error }),
				);
			}, 0);
			return view;
		},
		{ overlay: true, overlayOptions: { anchor: "center", width: "80%", maxHeight: "70%", margin: 1 } },
	);
	if (outcome.kind === "error") throw outcome.error;
	return outcome.kind === "ready" ? outcome.plan : undefined;
}

class PlanningProgressView implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly goal: string;
	private readonly cancel: () => void;
	private readonly startedAt = Date.now();
	private readonly timer: ReturnType<typeof setInterval>;
	private stage = "正在启动只读 planner…";
	private tools = 0;
	private turns = 0;
	private thinking = "";
	private stopping = false;

	constructor(tui: TUI, theme: Theme, keybindings: KeybindingsManager, goal: string, cancel: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.goal = goal;
		this.cancel = cancel;
		this.timer = setInterval(() => this.tui.requestRender(), 1000);
	}

	update(event: WorkflowPlanningEvent): void {
		if (this.stopping) return;
		if (event.kind === "starting") this.stage = "正在调查项目并制定步骤…";
		else if (event.kind === "tool") {
			this.tools++;
			this.stage =
				event.name === "project_read"
					? "正在阅读项目文件…"
					: event.name === "project_list"
						? "正在浏览项目目录…"
						: "正在整理项目资料…";
		} else if (event.kind === "turn") {
			this.turns = event.count;
			this.stage = "正在整理计划…";
		} else {
			// Keep only the visible tail so long planner runs do not retain unbounded reasoning text.
			this.thinking = (this.thinking + event.delta.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ")).slice(-4000);
			this.stage = "模型正在思考…";
		}
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (!this.stopping && this.keybindings.matches(data, "tui.select.cancel")) {
			this.stopping = true;
			this.stage = "正在取消规划…";
			this.cancel();
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 2);
		const border = (value: string) => this.theme.fg("border", value);
		const row = (value: string) => border("│") + truncateToWidth(` ${value}`, innerWidth, "…", true) + border("│");
		const title = truncateToWidth(" 正在生成计划 ", innerWidth);
		const bodyWidth = Math.max(1, innerWidth - 2);
		const visibleLines = Math.max(1, Math.min(6, Math.floor(this.tui.terminal.rows * 0.7) - 7));
		const thinkingLines = this.thinking
			? this.thinking
					.split("\n")
					.flatMap((line) => wrapTextWithAnsi(line, bodyWidth))
					.slice(-visibleLines)
			: ["等待模型返回可显示的思考内容…"];
		const lines = [
			border("╭") +
				this.theme.fg("accent", title) +
				border(`${"─".repeat(Math.max(0, innerWidth - visibleWidth(title)))}╮`),
			row(`目标：${this.goal}`),
			row(this.theme.fg("accent", this.stage)),
			row(
				`已运行 ${Math.floor((Date.now() - this.startedAt) / 1000)} 秒 · ${this.tools} 次项目操作 · ${this.turns} 轮`,
			),
			row(this.theme.fg("dim", "模型思考（实时）")),
		];
		for (const line of thinkingLines) lines.push(row(line));
		lines.push(row(this.theme.fg("dim", "Esc 取消 · 最长运行 180 秒")), border(`╰${"─".repeat(innerWidth)}╯`));
		return lines;
	}

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.timer);
	}
}
