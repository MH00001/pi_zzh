import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Mailbox, projectPath } from "./policy.ts";
import { StagedWorkspace } from "./staged-workspace.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
describe("team boundaries", () => {
	it("rejects traversal and protected files while allowing project files", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-test-"));
		dirs.push(root);
		expect(projectPath(root, "src/main.ts")).toBe(path.join(root, "src/main.ts"));
		for (const name of ["../secret", ".git/config", ".env", ".env.local", "auth.json", ".pi/extensions/x.ts"]) {
			expect(() => projectPath(root, name)).toThrow();
		}
	});
	it("rejects directory junction escapes", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-test-"));
		dirs.push(root);
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-test-"));
		dirs.push(outside);
		fs.symlinkSync(outside, path.join(root, "escape"), "junction");
		expect(() => projectPath(root, "escape/secret")).toThrow("Symlinks");
	});
	it("rejects dangling symlinks", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-test-"));
		dirs.push(root);
		fs.symlinkSync(path.join(root, "missing"), path.join(root, "dangling"), "junction");
		expect(() => projectPath(root, "dangling")).toThrow("Symlinks");
	});
	it("stages writes, reads the staged version, and applies on success", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-test-"));
		dirs.push(root);
		fs.writeFileSync(path.join(root, "existing.txt"), "before");
		const allowed = new Set([projectPath(root, "existing.txt"), projectPath(root, "new/file.txt")]);
		const workspace = new StagedWorkspace(root, allowed);
		await workspace.write("existing.txt", "after");
		await workspace.write("new/file.txt", "new text");
		expect(fs.readFileSync(path.join(root, "existing.txt"), "utf8")).toBe("before");
		expect(fs.existsSync(path.join(root, "new/file.txt"))).toBe(false);
		expect(await workspace.read("existing.txt")).toBe("after");
		expect(await workspace.list("new")).toBe("file.txt");
		expect(await workspace.apply()).toEqual(["existing.txt", path.join("new", "file.txt")]);
		expect(fs.readFileSync(path.join(root, "existing.txt"), "utf8")).toBe("after");
		expect(fs.readFileSync(path.join(root, "new/file.txt"), "utf8")).toBe("new text");
	});
	it("rejects a changed source before applying any staged file", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-test-"));
		dirs.push(root);
		fs.writeFileSync(path.join(root, "first.txt"), "first");
		fs.writeFileSync(path.join(root, "second.txt"), "second");
		const workspace = new StagedWorkspace(
			root,
			new Set([projectPath(root, "first.txt"), projectPath(root, "second.txt")]),
		);
		await workspace.write("first.txt", "changed first");
		await workspace.write("second.txt", "changed second");
		fs.writeFileSync(path.join(root, "second.txt"), "external edit");
		await expect(workspace.apply()).rejects.toThrow("File changed during assignment: second.txt");
		expect(fs.readFileSync(path.join(root, "first.txt"), "utf8")).toBe("first");
		expect(fs.readFileSync(path.join(root, "second.txt"), "utf8")).toBe("external edit");
	});
	it("detects changes made after a worker read but before its first write", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-test-"));
		dirs.push(root);
		fs.writeFileSync(path.join(root, "source.txt"), "worker saw this");
		const workspace = new StagedWorkspace(root, new Set([projectPath(root, "source.txt")]));
		expect(await workspace.read("source.txt")).toBe("worker saw this");
		fs.writeFileSync(path.join(root, "source.txt"), "changed externally");
		await workspace.write("source.txt", "based on stale read");
		await expect(workspace.apply()).rejects.toThrow("File changed during assignment");
		expect(fs.readFileSync(path.join(root, "source.txt"), "utf8")).toBe("changed externally");
	});
	it("delivers only to recipient, acknowledges once, and preserves sender", () => {
		const box = new Mailbox();
		box.send("scout", "planner", "entry.ts contains the entry point");
		box.send("worker", "coordinator", "ready for review");
		expect(box.drain("reviewer")).toEqual([]);
		expect(box.drain("planner")).toEqual([
			{ from: "scout", to: "planner", text: "entry.ts contains the entry point" },
		]);
		expect(box.drain("planner")).toEqual([]);
		expect(box.list()).toHaveLength(1);
	});
	it("bounds mail growth and disallows self loops", () => {
		const box = new Mailbox();
		expect(() => box.send("scout", "scout", "loop")).toThrow();
		expect(() => box.send("scout", "planner", "x".repeat(4001))).toThrow();
		for (let i = 0; i < 64; i++) box.send("scout", "planner", "hello");
		expect(() => box.send("scout", "planner", "full")).toThrow("full");
	});
});
