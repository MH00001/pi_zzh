import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { WorktreeTasks } from "./worktree.ts";

const execFileAsync = promisify(execFile);
const dirs: string[] = [];
const git = async (cwd: string, args: string[]) =>
	(await execFileAsync("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 })).stdout;

async function repository() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-worktree-"));
	dirs.push(dir);
	const root = path.join(dir, "repo");
	fs.mkdirSync(root);
	await git(root, ["init", "-b", "main"]);
	fs.writeFileSync(path.join(root, "file.txt"), "base");
	fs.mkdirSync(path.join(root, "src"));
	fs.writeFileSync(path.join(root, "src", "inner.txt"), "inner base");
	await git(root, ["add", "--", "file.txt", "src/inner.txt"]);
	await git(root, ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-m", "initial"]);
	return { root, manager: await WorktreeTasks.open(root, path.join(dir, "agent"), git) };
}

afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("team Git worktrees", () => {
	it("keeps work in a task branch until a clean fast-forward apply", async () => {
		const { root, manager } = await repository();
		const { task } = await manager.create("change file");
		await manager.authorize(task, ["file.txt", path.join("src", "inner.txt"), path.join("src", "new.txt")]);
		fs.writeFileSync(path.join(task.worktree, "file.txt"), "agent change");
		fs.writeFileSync(path.join(task.worktree, "src", "inner.txt"), "nested change");
		fs.writeFileSync(path.join(task.worktree, "src", "new.txt"), "new agent file");
		expect(await manager.diff(task)).toContain("new agent file");
		const commit = await manager.checkpoint(task, "change file in task");
		await manager.recordCheck(task, "node", ["--version"], {
			stdout: "v24",
			stderr: "",
			code: 0,
			killed: false,
			truncated: false,
		});
		expect(task.checks[0]?.commit).toBe(commit);
		expect(fs.readFileSync(path.join(root, "file.txt"), "utf8")).toBe("base");
		expect(await manager.diff(task)).toContain("agent change");
		expect((await manager.apply(task)).mode).toBe("fast-forward");
		expect(fs.readFileSync(path.join(root, "file.txt"), "utf8")).toBe("agent change");
		expect(fs.readFileSync(path.join(root, "src", "inner.txt"), "utf8")).toBe("nested change");
		expect(fs.readFileSync(path.join(root, "src", "new.txt"), "utf8")).toBe("new agent file");
		expect((await git(root, ["rev-parse", "HEAD"])).trim()).toBe(commit);
		await manager.archive(task);
		expect(fs.existsSync(task.worktree)).toBe(false);
		expect((await git(root, ["branch", "--list", task.branch])).trim()).toContain(task.branch);
	});

	it("snapshots dirty tracked files and selected untracked files without changing main history", async () => {
		const { root, manager } = await repository();
		const before = (await git(root, ["rev-parse", "HEAD"])).trim();
		fs.writeFileSync(path.join(root, "file.txt"), "user edit");
		fs.writeFileSync(path.join(root, "src", "draft.txt"), "draft");
		fs.writeFileSync(path.join(root, "omitted.txt"), "not copied");
		const { task, omittedUntracked } = await manager.create("build on local edits");
		expect(omittedUntracked).toContain("src/draft.txt");
		expect(omittedUntracked).toContain("omitted.txt");
		expect(fs.readFileSync(path.join(task.worktree, "file.txt"), "utf8")).toBe("user edit");
		expect(fs.existsSync(path.join(task.worktree, "src", "draft.txt"))).toBe(false);
		await manager.include(task, [path.join("src", "draft.txt")]);
		expect(fs.readFileSync(path.join(task.worktree, "src", "draft.txt"), "utf8")).toBe("draft");
		expect(fs.existsSync(path.join(task.worktree, "omitted.txt"))).toBe(false);
		expect((await git(root, ["rev-parse", "HEAD"])).trim()).toBe(before);
		await manager.authorize(task, ["file.txt"]);
		await expect(manager.include(task, ["omitted.txt"])).rejects.toThrow("before team work");
		fs.writeFileSync(path.join(task.worktree, "file.txt"), "agent result");
		await manager.checkpoint(task, "finish task change");
		expect((await manager.apply(task)).mode).toBe("files");
		expect(fs.readFileSync(path.join(root, "file.txt"), "utf8")).toBe("agent result");
		expect(fs.readFileSync(path.join(root, "src", "draft.txt"), "utf8")).toBe("draft");
		expect((await git(root, ["rev-parse", "HEAD"])).trim()).toBe(before);
	});

	it("blocks changed main files and unmanaged worktree changes", async () => {
		const { root, manager } = await repository();
		const { task } = await manager.create("change file");
		await manager.authorize(task, ["file.txt"]);
		fs.writeFileSync(path.join(task.worktree, "unmanaged.txt"), "extra");
		await expect(manager.checkpoint(task, "invalid")).rejects.toThrow("Unmanaged");
		fs.rmSync(path.join(task.worktree, "unmanaged.txt"));
		fs.writeFileSync(path.join(task.worktree, "file.txt"), "agent edit");
		await manager.checkpoint(task, "valid");
		fs.writeFileSync(path.join(root, "file.txt"), "other editor");
		await expect(manager.apply(task)).rejects.toThrow("Main checkout changed");
		expect(fs.readFileSync(path.join(root, "file.txt"), "utf8")).toBe("other editor");
		expect(task.state).toBe("active");
	});
});
