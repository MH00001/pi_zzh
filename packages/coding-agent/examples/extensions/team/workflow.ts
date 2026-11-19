// Structured plans and request routes for the team workflow.
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const stepSchema = Type.Object(
	{
		id: Type.Integer({ minimum: 1, maximum: 8 }),
		task: Type.String({ minLength: 1, maxLength: 1000 }),
		writePaths: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 20 }),
		acceptance: Type.String({ minLength: 1, maxLength: 1000 }),
	},
	{ additionalProperties: false },
);
const planSchema = Type.Object(
	{
		goal: Type.String({ minLength: 1, maxLength: 2000 }),
		steps: Type.Array(stepSchema, { minItems: 1, maxItems: 8 }),
	},
	{ additionalProperties: false },
);
export type WorkflowPlan = Static<typeof planSchema>;
export type WorkflowRoute = "single" | "multi";

const routeSchema = Type.Object(
	{ route: Type.Union([Type.Literal("single"), Type.Literal("multi")]) },
	{ additionalProperties: false },
);

/** Parse a planner or editor response and require sequential, uniquely numbered steps. */
export function parseWorkflowPlan(text: string): WorkflowPlan {
	const value: unknown = JSON.parse(
		text
			.trim()
			.replace(/^```(?:json)?\s*/i, "")
			.replace(/\s*```$/, ""),
	);
	if (!Value.Check(planSchema, value) || value.steps.some((step, index) => step.id !== index + 1)) {
		throw new Error("Plan must contain 1–8 sequential steps with task, writePaths, and acceptance");
	}
	return value;
}

/** Render a complete plan for review before approval. */
export function renderWorkflowPlan(plan: WorkflowPlan, version: number): string {
	return [
		`计划 v${version}：${plan.goal}`,
		...plan.steps.flatMap((step) => [
			`${step.id}. ${step.task}`,
			`   修改文件：${step.writePaths.length ? step.writePaths.join(", ") : "无"}`,
			`   验收：${step.acceptance}`,
		]),
	].join("\n");
}

/** Classify a normal user request before the main agent runs; failure keeps the single-agent path. */
export async function decideWorkflowRoute(
	prompt: string,
	registry: ModelRegistry,
	model: Model<Api> | undefined,
): Promise<WorkflowRoute> {
	const request = prompt.trim();
	if (
		!model ||
		/^(?:你好|您好|嗨|hi|hello|谢谢|thanks)[！!。.?？\s]*$/i.test(request) ||
		(request.length < 160 && /^(?:什么是|解释一下|请解释|为什么|怎么理解|what is|why does|explain)/i.test(request))
	)
		return "single";
	try {
		const response = await registry.complete(
			model,
			{
				systemPrompt: `Route one user request. Return only JSON: {"route":"single"} or {"route":"multi"}.
Choose single for questions, explanations, reviews, narrow edits, and tasks one agent can complete directly.
Choose multi only when independent investigation, implementation, or review roles would materially help, or the task has several separable work streams. Do not infer a request to modify files from a question.`,
				messages: [
					{ role: "user", content: [{ type: "text", text: prompt.slice(0, 4000) }], timestamp: Date.now() },
				],
			},
			{ maxTokens: 80, cacheRetention: "none", timeoutMs: 10_000, maxRetries: 0 },
		);
		if (response.stopReason !== "stop") return "single";
		const text = response.content
			.filter((item) => item.type === "text")
			.map((item) => item.text)
			.join("\n");
		const value: unknown = JSON.parse(
			text
				.trim()
				.replace(/^```(?:json)?\s*/i, "")
				.replace(/\s*```$/, ""),
		);
		return Value.Check(routeSchema, value) ? value.route : "single";
	} catch {
		return "single";
	}
}
