import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { compareMemory } from "./reconcile.ts";
import type { MemoryInput, MemoryRecord } from "./store.ts";

const at = new Date().toISOString();
const candidate: MemoryInput = {
	scope: "repo",
	kind: "project_fact",
	topic: "database",
	fact: "Use PostgreSQL",
	verification: "user_reported",
	source: { origin: "user", sessionId: "now", entryId: "new", at },
};
const previous: MemoryRecord = {
	id: "previous",
	scope: "repo",
	kind: "project_fact",
	topic: "database",
	fact: "Use SQLite",
	recordedAt: at,
	updatedAt: at,
	status: "active",
	verification: "user_reported",
	sources: [candidate.source],
};
const model = {} as Model<Api>;

function registry(text: string, stopReason = "stop") {
	const complete = vi.fn(
		async () => ({ stopReason, content: [{ type: "text", text }] }) as unknown as AssistantMessage,
	);
	return { complete, value: { complete } as unknown as ModelRegistry };
}

describe("memory semantic comparison", () => {
	it("compares within scope using a bounded call and validates replacement IDs", async () => {
		const client = registry(
			JSON.stringify({ action: "replace", ids: [previous.id], reason: "The database changed" }),
		);
		const result = await compareMemory(client.value, model, candidate, [
			previous,
			{ ...previous, id: "global", scope: "user" },
			{ ...previous, id: "archived", status: "superseded" },
		]);
		expect(result).toEqual({ action: "replace", ids: [previous.id], reason: "The database changed" });
		expect(client.complete).toHaveBeenCalledWith(
			model,
			expect.objectContaining({
				systemPrompt: expect.stringContaining("Topic equality alone does not imply a conflict"),
				messages: [
					expect.objectContaining({
						content: [
							{
								type: "text",
								text: JSON.stringify({
									candidate,
									existing: [
										{
											id: previous.id,
											scope: previous.scope,
											kind: previous.kind,
											topic: previous.topic,
											fact: previous.fact,
											verification: previous.verification,
											state: "active",
											latestSourceAt: at,
										},
									],
								}),
							},
						],
					}),
				],
			}),
			expect.objectContaining({ timeoutMs: 20_000, maxRetries: 0 }),
		);
	});

	it.each([
		[JSON.stringify({ action: "replace", ids: ["unseen"], reason: "unknown" }), "stop", "unseen"],
		[JSON.stringify({ action: "replace", ids: [], reason: "empty" }), "stop", "Invalid"],
		[JSON.stringify({ action: "delete", id: "previous" }), "stop", "Invalid"],
		[JSON.stringify({ action: "add" }), "length", "stopped"],
	])("rejects unsafe or incomplete comparison output %#", async (text, reason, error) => {
		const client = registry(text, reason);
		await expect(compareMemory(client.value, model, candidate, [previous])).rejects.toThrow(error);
	});

	it("does not call the provider for an empty comparison set", async () => {
		const client = registry("unused");
		expect(await compareMemory(client.value, model, candidate, [])).toEqual({ action: "add" });
		expect(client.complete).not.toHaveBeenCalled();
	});
});
