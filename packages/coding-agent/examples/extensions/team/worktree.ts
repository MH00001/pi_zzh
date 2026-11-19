// A task owns one Git branch and worktree; the main checkout is changed only by explicit apply.
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { projectPath } from "./policy.ts";

export type GitRunner = (cwd: string, args: string[]) => Promise<string>;

export interface WorktreeTask {
	id: string;
	goal: string;
	root: string;
	worktree: string;
	branch: string;
	baseCommit: string;
	baselineCommit: string;
	createdAt: string;
	state: "active" | "applied" | "archived";
	contextEpoch: number;
	baselinePaths: string[];
	managedPaths: string[];
	expected: Record<string, string | null>;
	checkpoints: Array<{ commit: string; message: string }>;
	checks: Array<{
		commit: string;
		command: string;
		args: string[];
		code: number;
		killed: boolean;
		truncated: boolean;
		output: string;
		at: string;
	}>;
	applyMode?: "fast-forward" | "files";
	appliedPaths?: string[];
}

export interface CreatedWorktree {
	task: WorktreeTask;
	omittedUntracked: string[];
	omittedProtected: string[];
}

const splitPaths = (value: string): string[] => value.split("\0").filter(Boolean);
const gitPath = (value: string): string => (process.platform === "win32" ? value.replaceAll("\\", "/") : value);
const digest = (content: Buffer | undefined): string | null =>
	content === undefined ? null : createHash("sha256").update(content).digest("hex");

export class WorktreeTasks {
	readonly root: string;
	private readonly dataDir: string;
	private readonly worktreeDir: string;
	private readonly git: GitRunner;

	private constructor(root: string, dataDir: string, worktreeDir: string, git: GitRunner) {
		this.root = root;
		this.dataDir = dataDir;
		this.worktreeDir = worktreeDir;
		this.git = git;
	}

	static async open(cwd: string, agentDir: string, git: GitRunner): Promise<WorktreeTasks> {
		const root = path.resolve((await git(cwd, ["rev-parse", "--show-toplevel"])).trim());
		const key = createHash("sha256").update(root.toLowerCase()).digest("hex").slice(0, 16);
		return new WorktreeTasks(
			root,
			path.join(agentDir, "team-worktrees", key),
			path.join(path.dirname(root), `${path.basename(root)}-worktrees`),
			git,
		);
	}

	async create(goal: string, includePaths: string[] = []): Promise<CreatedWorktree> {
		if (!goal.trim() || goal.length > 1000) throw new Error("Task goal must contain 1–1000 characters");
		if (includePaths.length > 20) throw new Error("At most 20 untracked files may be included");
		const baseCommit = (await this.git(this.root, ["rev-parse", "HEAD"])).trim();
		const tracked = splitPaths(await this.git(this.root, ["diff", "--name-only", "-z", "--no-renames", "HEAD"]));
		const untracked = splitPaths(await this.git(this.root, ["ls-files", "--others", "--exclude-standard", "-z"]));
		const untrackedSet = new Set(untracked);
		const included = [...new Set(includePaths.map(gitPath))];
		for (const file of included) {
			if (!untrackedSet.has(file)) throw new Error(`Not an untracked project file: ${file}`);
			projectPath(this.root, file);
		}
		const id = `t-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
		const branch = `agent/${id}`;
		const worktree = path.join(this.worktreeDir, id);
		await fs.mkdir(this.worktreeDir, { recursive: true });
		await this.git(this.root, ["worktree", "add", "-b", branch, worktree, baseCommit]);
		const copied: string[] = [];
		const omittedProtected: string[] = [];
		for (const file of [...new Set([...tracked, ...included])]) {
			try {
				await this.copySnapshot(file, worktree);
				copied.push(file);
			} catch (error) {
				if (
					error instanceof Error &&
					/Protected path|Symlinks are not allowed|Ambiguous path/.test(error.message)
				) {
					omittedProtected.push(file);
					continue;
				}
				throw new Error(`Task worktree retained at ${worktree}; snapshot failed for ${file}`, { cause: error });
			}
		}
		let baselineCommit = baseCommit;
		if (copied.length) {
			await this.git(worktree, ["add", "--", ...copied]);
			await this.git(worktree, [
				"-c",
				"user.name=Pi Team",
				"-c",
				"user.email=pi-team@localhost",
				"commit",
				"-m",
				`team baseline: ${id}`,
			]);
			baselineCommit = (await this.git(worktree, ["rev-parse", "HEAD"])).trim();
		}
		const task: WorktreeTask = {
			id,
			goal: goal.trim(),
			root: this.root,
			worktree,
			branch,
			baseCommit,
			baselineCommit,
			createdAt: new Date().toISOString(),
			state: "active",
			contextEpoch: 0,
			baselinePaths: copied,
			managedPaths: [],
			expected: {},
			checkpoints: [],
			checks: [],
		};
		await this.save(task);
		return { task, omittedUntracked: untracked.filter((file) => !included.includes(file)), omittedProtected };
	}

	async include(task: WorktreeTask, files: string[]): Promise<string> {
		await this.assertTask(task);
		if (task.state !== "active" || task.managedPaths.length || task.checkpoints.length) {
			throw new Error("Untracked files can be included only before team work begins");
		}
		if (!files.length || files.length > 20) throw new Error("Include 1–20 untracked files");
		if ((await this.git(task.worktree, ["status", "--porcelain"])).trim()) {
			throw new Error("Task worktree must be clean before extending its baseline");
		}
		const untracked = new Set(
			splitPaths(await this.git(this.root, ["ls-files", "--others", "--exclude-standard", "-z"])),
		);
		const selected = [...new Set(files.map(gitPath))];
		for (const file of selected) {
			if (!untracked.has(file) || task.baselinePaths.includes(file)) {
				throw new Error(`Not an omitted untracked file: ${file}`);
			}
			projectPath(this.root, file);
			projectPath(task.worktree, file);
		}
		for (const file of selected) await this.copySnapshot(file, task.worktree);
		await this.git(task.worktree, ["add", "--", ...selected]);
		await this.git(task.worktree, [
			"-c",
			"user.name=Pi Team",
			"-c",
			"user.email=pi-team@localhost",
			"commit",
			"-m",
			`team baseline include: ${task.id}`,
		]);
		task.baselineCommit = (await this.git(task.worktree, ["rev-parse", "HEAD"])).trim();
		task.baselinePaths.push(...selected);
		await this.save(task);
		return task.baselineCommit;
	}

	async rotateContexts(task: WorktreeTask): Promise<void> {
		if (task.state !== "active") return;
		task.contextEpoch++;
		await this.save(task);
	}

	async list(): Promise<WorktreeTask[]> {
		let files: string[];
		try {
			files = await fs.readdir(this.dataDir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const tasks = await Promise.all(
			files.filter((file) => /^t-[a-z0-9-]+\.json$/.test(file)).map((file) => this.load(file.slice(0, -5))),
		);
		return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	async load(id: string): Promise<WorktreeTask> {
		if (!/^t-[a-z0-9-]+$/.test(id)) throw new Error("Invalid task ID");
		const task = JSON.parse(await fs.readFile(path.join(this.dataDir, `${id}.json`), "utf8")) as WorktreeTask;
		if (
			task.id !== id ||
			task.root !== this.root ||
			task.worktree !== path.join(this.worktreeDir, id) ||
			task.branch !== `agent/${id}`
		)
			throw new Error("Task metadata does not match this repository");
		return task;
	}

	async describe(task: WorktreeTask): Promise<string> {
		if (task.state === "archived") return JSON.stringify(task);
		await this.assertTask(task);
		const [status, stat, commits] = await Promise.all([
			this.git(task.worktree, ["status", "--short"]),
			this.git(task.worktree, ["diff", "--stat", task.baselineCommit]),
			this.git(task.worktree, ["log", "--oneline", `${task.baselineCommit}..HEAD`]),
		]);
		return JSON.stringify({ ...task, status: status.trim(), changeStat: stat.trim(), commits: commits.trim() });
	}

	async diff(task: WorktreeTask): Promise<string> {
		await this.assertTask(task);
		const changes = task.managedPaths.length
			? await this.git(task.worktree, ["diff", "--no-ext-diff", task.baselineCommit, "--", ...task.managedPaths])
			: "";
		const untracked = splitPaths(
			await this.git(task.worktree, ["ls-files", "--others", "--exclude-standard", "-z"]),
		).filter((file) => task.managedPaths.includes(file));
		const untrackedManaged = await Promise.all(
			untracked.map(async (file) => {
				const content = await this.readFile(projectPath(task.worktree, file));
				return {
					file,
					preview: content?.toString("utf8").slice(0, 4000),
					truncated: (content?.length ?? 0) > 4000,
				};
			}),
		);
		const committed = splitPaths(
			await this.git(task.worktree, ["diff", "--name-only", "-z", task.baselineCommit, "HEAD"]),
		);
		const other = [...new Set([...(await this.changedPaths(task.worktree)), ...committed])].filter(
			(file) => !task.managedPaths.includes(file),
		);
		return JSON.stringify({
			diff: changes.slice(0, 24000),
			truncated: changes.length > 24000,
			untrackedManaged,
			otherChanges: other,
		});
	}

	async recordCheck(
		task: WorktreeTask,
		command: string,
		args: string[],
		outcome: { stdout: string; stderr: string; code: number; killed: boolean; truncated: boolean },
	): Promise<WorktreeTask["checks"][number]> {
		await this.assertTask(task);
		if (task.state !== "active") throw new Error("Task is no longer active");
		const entry = {
			commit: (await this.git(task.worktree, ["rev-parse", "HEAD"])).trim(),
			command,
			args,
			code: outcome.code,
			killed: outcome.killed,
			truncated: outcome.truncated,
			output: `${outcome.stdout}\n${outcome.stderr}`.slice(-4000),
			at: new Date().toISOString(),
		};
		task.checks.push(entry);
		if (task.checks.length > 20) task.checks.shift();
		await this.save(task);
		return entry;
	}

	async authorize(task: WorktreeTask, files: string[]): Promise<void> {
		await this.assertTask(task);
		if (task.state !== "active") throw new Error("Task is no longer active");
		for (const file of files) {
			const main = projectPath(this.root, file);
			const worktree = projectPath(task.worktree, file);
			const relative = gitPath(path.relative(this.root, main));
			const current = digest(await this.readFile(main));
			if (Object.hasOwn(task.expected, relative)) {
				if (current !== task.expected[relative]) throw new Error(`Main checkout changed: ${relative}`);
			} else {
				if (current !== digest(await this.readFile(worktree))) {
					throw new Error(`Task copy differs from main checkout: ${relative}`);
				}
				task.expected[relative] = current;
			}
			if (!task.managedPaths.includes(relative)) task.managedPaths.push(relative);
		}
		await this.save(task);
	}

	async checkpoint(task: WorktreeTask, message: string): Promise<string> {
		await this.assertTask(task);
		if (task.state !== "active") throw new Error("Task is no longer active");
		if (!message.trim() || message.length > 200) throw new Error("Checkpoint message must contain 1–200 characters");
		const changed = await this.changedPaths(task.worktree);
		if (!changed.length) throw new Error("No worktree changes to checkpoint");
		const other = changed.filter((file) => !task.managedPaths.includes(file));
		if (other.length) throw new Error(`Unmanaged changes in worktree: ${other.join(", ")}`);
		await this.git(task.worktree, ["add", "--", ...changed]);
		await this.git(task.worktree, [
			"-c",
			"user.name=Pi Team",
			"-c",
			"user.email=pi-team@localhost",
			"commit",
			"-m",
			message.trim(),
		]);
		const commit = (await this.git(task.worktree, ["rev-parse", "HEAD"])).trim();
		task.checkpoints.push({ commit, message: message.trim() });
		await this.save(task);
		return commit;
	}

	async apply(task: WorktreeTask): Promise<{ mode: "fast-forward" | "files"; paths: string[] }> {
		await this.assertTask(task);
		if (task.state !== "active") throw new Error("Task is no longer active");
		if ((await this.git(task.worktree, ["status", "--porcelain"])).trim()) {
			throw new Error("Checkpoint or remove uncommitted worktree changes before applying");
		}
		const changed = splitPaths(
			await this.git(task.worktree, ["diff", "--name-only", "-z", task.baselineCommit, "HEAD"]),
		);
		if (!changed.length) throw new Error("No task changes to apply");
		const other = changed.filter((file) => !task.managedPaths.includes(file) || !Object.hasOwn(task.expected, file));
		if (other.length) throw new Error(`Unmanaged task changes: ${other.join(", ")}`);
		const stagedMain = splitPaths(await this.git(this.root, ["diff", "--cached", "--name-only", "-z"]));
		const overlap = changed.filter((file) => stagedMain.includes(file));
		if (overlap.length) throw new Error(`Main index has staged changes: ${overlap.join(", ")}`);
		const operations: Array<{ file: string; target: string; source: string; content: Buffer | undefined }> = [];
		for (const file of changed) {
			const target = projectPath(this.root, file);
			if (digest(await this.readFile(target)) !== task.expected[file]) {
				throw new Error(`Main checkout changed since task baseline: ${file}`);
			}
			const source = projectPath(task.worktree, file);
			operations.push({ file, target, source, content: await this.readFile(source) });
		}
		const mainStatus = (await this.git(this.root, ["status", "--porcelain"])).trim();
		const mainHead = (await this.git(this.root, ["rev-parse", "HEAD"])).trim();
		if (!mainStatus && mainHead === task.baseCommit && task.baselineCommit === task.baseCommit) {
			await this.git(this.root, ["merge", "--ff-only", task.branch]);
			task.state = "applied";
			task.applyMode = "fast-forward";
			task.appliedPaths = changed;
			await this.save(task);
			return { mode: "fast-forward", paths: changed };
		}
		const applied: string[] = [];
		for (const operation of operations) {
			try {
				projectPath(this.root, operation.file);
				if (digest(await this.readFile(operation.target)) !== task.expected[operation.file]) {
					throw new Error("Main file changed during apply");
				}
				if (operation.content === undefined) {
					await fs.rm(operation.target);
				} else {
					await fs.mkdir(path.dirname(operation.target), { recursive: true });
					projectPath(this.root, operation.file);
					const temporary = `${operation.target}.pi-team-${randomUUID()}.tmp`;
					const mode = (await fs.stat(operation.target).catch(() => fs.stat(operation.source))).mode;
					try {
						await fs.writeFile(temporary, operation.content, { flag: "wx", mode });
						await fs.rename(temporary, operation.target);
					} finally {
						await fs.rm(temporary, { force: true });
					}
				}
				applied.push(operation.file);
			} catch (error) {
				throw new Error(`Apply stopped at ${operation.file}; already applied: ${JSON.stringify(applied)}`, {
					cause: error,
				});
			}
		}
		task.state = "applied";
		task.applyMode = "files";
		task.appliedPaths = applied;
		await this.save(task);
		return { mode: "files", paths: applied };
	}

	async archive(task: WorktreeTask): Promise<void> {
		await this.assertTask(task);
		if ((await this.git(task.worktree, ["status", "--porcelain"])).trim()) {
			throw new Error("Worktree has uncommitted changes; checkpoint them first");
		}
		await this.git(this.root, ["worktree", "remove", task.worktree]);
		task.state = "archived";
		await this.save(task);
	}

	private async assertTask(task: WorktreeTask): Promise<void> {
		if (task.root !== this.root || task.state === "archived")
			throw new Error("Task is not active in this repository");
		const actual = path.resolve((await this.git(task.worktree, ["rev-parse", "--show-toplevel"])).trim());
		const branch = (await this.git(task.worktree, ["branch", "--show-current"])).trim();
		if (actual !== task.worktree || branch !== task.branch)
			throw new Error("Task worktree or branch changed outside team extension");
	}

	private async changedPaths(cwd: string): Promise<string[]> {
		const tracked = splitPaths(await this.git(cwd, ["diff", "--name-only", "-z", "HEAD"]));
		const untracked = splitPaths(await this.git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]));
		return [...new Set([...tracked, ...untracked])];
	}

	private async copySnapshot(file: string, worktree: string): Promise<void> {
		const source = projectPath(this.root, file);
		const target = projectPath(worktree, file);
		const content = await this.readFile(source);
		if (content === undefined) {
			await fs.rm(target, { force: true });
			return;
		}
		if (content.length > 8 * 1024 * 1024) throw new Error("Snapshot file exceeds 8 MiB");
		await fs.mkdir(path.dirname(target), { recursive: true });
		projectPath(worktree, file);
		await fs.writeFile(target, content);
	}

	private async readFile(file: string): Promise<Buffer | undefined> {
		try {
			return await fs.readFile(file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	private async save(task: WorktreeTask): Promise<void> {
		await fs.mkdir(this.dataDir, { recursive: true });
		const target = path.join(this.dataDir, `${task.id}.json`);
		const temporary = `${target}.${randomUUID()}.tmp`;
		try {
			await fs.writeFile(temporary, JSON.stringify(task, null, 2), { flag: "wx" });
			await fs.rename(temporary, target);
		} finally {
			await fs.rm(temporary, { force: true });
		}
	}
}
