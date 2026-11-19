// Scrollable plan review and approval UI for the team workflow.
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type KeybindingsManager,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { renderWorkflowPlan, type WorkflowPlan } from "./workflow.ts";

export type WorkflowApprovalAction = "approve" | "edit" | "later";

const actions: { label: string; value: WorkflowApprovalAction }[] = [
	{ label: "批准并执行", value: "approve" },
	{ label: "编辑计划", value: "edit" },
	{ label: "稍后决定", value: "later" },
];

/** Keep the full plan visible while the user chooses how to proceed. */
export async function showWorkflowApproval(
	plan: WorkflowPlan,
	version: number,
	ctx: ExtensionContext,
): Promise<WorkflowApprovalAction> {
	const text = renderWorkflowPlan(plan, version);
	if (ctx.mode !== "tui") {
		if (!ctx.hasUI) {
			ctx.ui.notify(text, "info");
			return "later";
		}
		const choice = await ctx.ui.select(
			text,
			actions.map((action) => action.label),
		);
		return actions.find((action) => action.label === choice)?.value ?? "later";
	}
	return ctx.ui.custom<WorkflowApprovalAction>(
		(tui, theme, keybindings, done) => new WorkflowApprovalView(tui, theme, keybindings, text, version, done),
		{ overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "90%", margin: 1 } },
	);
}

class WorkflowApprovalView implements Component {
	readonly capturesViewportInput = true;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly text: string;
	private readonly version: number;
	private readonly done: (action: WorkflowApprovalAction) => void;
	private selected = 0;
	private offset = 0;
	private visibleLines = 1;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		text: string,
		version: number,
		done: (action: WorkflowApprovalAction) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.text = text;
		this.version = version;
		this.done = done;
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.done("later");
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			this.done(actions[this.selected]!.value);
			return;
		}
		if (this.keybindings.matches(data, "tui.input.tab")) {
			this.selected = (this.selected + 1) % actions.length;
		} else if (this.keybindings.matches(data, "tui.select.up")) {
			this.offset = Math.max(0, this.offset - 1);
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			this.offset++;
		} else if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.offset = Math.max(0, this.offset - this.visibleLines);
		} else if (this.keybindings.matches(data, "tui.select.pageDown")) {
			this.offset += this.visibleLines;
		} else {
			return;
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 2);
		const bodyWidth = Math.max(1, innerWidth - 2);
		const body = this.text.split("\n").flatMap((line) => wrapTextWithAnsi(line, bodyWidth));
		const maxHeight = Math.max(6, Math.floor(this.tui.terminal.rows * 0.9));
		this.visibleLines = Math.max(1, Math.min(body.length, maxHeight - 5));
		this.offset = Math.min(this.offset, Math.max(0, body.length - this.visibleLines));
		const border = (value: string) => this.theme.fg("border", value);
		const row = (value: string) => border("│") + truncateToWidth(` ${value}`, innerWidth, "…", true) + border("│");
		const title = truncateToWidth(` 审核计划 v${this.version} `, innerWidth);
		const lines = [
			border("╭") +
				this.theme.fg("accent", title) +
				border(`${"─".repeat(Math.max(0, innerWidth - visibleWidth(title)))}╮`),
			row(
				this.theme.fg(
					"dim",
					`计划内容 ${this.offset + 1}-${Math.min(body.length, this.offset + this.visibleLines)}/${body.length} · ↑↓/PgUp/PgDn 滚动`,
				),
			),
		];
		for (const line of body.slice(this.offset, this.offset + this.visibleLines)) lines.push(row(line));
		lines.push(
			row(
				actions
					.map((action, index) =>
						index === this.selected
							? this.theme.fg("accent", `[${action.label}]`)
							: this.theme.fg("muted", ` ${action.label} `),
					)
					.join("  "),
			),
			row(this.theme.fg("dim", "Tab 切换操作 · Enter 确认 · Esc 稍后")),
			border(`╰${"─".repeat(innerWidth)}╯`),
		);
		return lines;
	}

	invalidate(): void {}
}
