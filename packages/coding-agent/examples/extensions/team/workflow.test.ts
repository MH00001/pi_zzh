import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { decideWorkflowRoute, parseWorkflowPlan, renderWorkflowPlan } from "./workflow.ts";

describe("structured team workflow", () => {
	it("requires numbered steps with explicit acceptance and write paths", () => {
		const plan = parseWorkflowPlan(
			'```json\n{"goal":"修复登录","steps":[{"id":1,"task":"检查登录流程","writePaths":[],"acceptance":"找到失败路径"},{"id":2,"task":"修复","writePaths":["src/login.ts"],"acceptance":"测试通过"}]}\n```',
		);
		expect(renderWorkflowPlan(plan, 2)).toContain("计划 v2：修复登录");
		expect(() =>
			parseWorkflowPlan('{"goal":"x","steps":[{"id":2,"task":"y","writePaths":[],"acceptance":"z"}]}'),
		).toThrow("sequential");
		expect(() => parseWorkflowPlan('{"goal":"x","steps":[{"id":1,"task":"y","writePaths":[]}]}')).toThrow(
			"sequential",
		);
	});

	it("routes greetings directly and accepts only a structured model decision", async () => {
		const complete = vi.fn().mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: '{"route":"multi"}' }],
		});
		const registry = { complete } as unknown as ModelRegistry;
		const model = { id: "fake" } as Parameters<typeof decideWorkflowRoute>[2];
		expect(await decideWorkflowRoute("你好", registry, model)).toBe("single");
		expect(complete).not.toHaveBeenCalled();
		expect(await decideWorkflowRoute("并行调查并修复两个模块", registry, model)).toBe("multi");
		complete.mockResolvedValueOnce({ stopReason: "stop", content: [{ type: "text", text: "multi" }] });
		expect(await decideWorkflowRoute("调查模块", registry, model)).toBe("single");
	});
});
