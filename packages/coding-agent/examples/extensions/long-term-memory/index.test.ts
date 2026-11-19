import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadExtensions } from "../../../src/core/extensions/loader.ts";

describe("long-term-memory extension registration", () => {
	it("loads with Pi and exposes bounded read and write model tools", async () => {
		const filename = fileURLToPath(new URL("./index.ts", import.meta.url));
		const result = await loadExtensions([filename], fileURLToPath(new URL("../../../", import.meta.url)));
		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].commands.has("memory")).toBe(true);
		const tool = result.extensions[0].tools.get("memory_search");
		expect(tool?.definition.exposure).toBe("model-only");
		expect(result.extensions[0].tools.get("memory_write")?.definition.exposure).toBe("model-only");
		expect(result.extensions[0].tools.size).toBe(2);
	});
});
