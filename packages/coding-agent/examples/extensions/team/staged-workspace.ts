// Hold one worker assignment's writes until its final response succeeds.

import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { projectPath } from "./policy.ts";

interface StagedFile {
	before: Buffer | undefined;
	content: string;
}

export class StagedWorkspace {
	private readonly files = new Map<string, StagedFile>();
	private readonly observed = new Map<string, Buffer>();
	private readonly root: string;
	private readonly allowed: ReadonlySet<string>;

	constructor(root: string, allowed: ReadonlySet<string>) {
		this.root = root;
		this.allowed = allowed;
	}

	async read(input: string, offset = 0): Promise<string> {
		const target = projectPath(this.root, input);
		const staged = this.files.get(target);
		if (staged) return staged.content.slice(offset, offset + 16000);
		const file = await fs.readFile(target);
		if (file.length > 1024 * 1024) throw new Error("File exceeds 1 MiB");
		if (this.allowed.has(target) && !this.observed.has(target)) this.observed.set(target, file);
		return file.toString("utf8").slice(offset, offset + 16000);
	}

	async write(input: string, content: string): Promise<void> {
		const target = projectPath(this.root, input);
		if (!this.allowed.has(target)) throw new Error("File is not authorized for this assignment");
		const prior = this.files.get(target);
		if (prior) {
			prior.content = content;
			return;
		}
		const before = this.observed.get(target) ?? (await this.readCurrent(target));
		this.files.set(target, { before, content });
	}

	async list(input: string): Promise<string> {
		const directory = projectPath(this.root, input);
		let entries: Dirent[];
		try {
			entries = await fs.readdir(directory, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			entries = [];
		}
		const names = new Set<string>();
		for (const entry of entries) {
			try {
				projectPath(this.root, path.join(directory, entry.name));
				names.add(`${entry.name}${entry.isDirectory() ? "/" : ""}`);
			} catch {
				// Do not expose protected entries.
			}
		}
		for (const target of this.files.keys()) {
			const relative = path.relative(directory, target);
			if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
			const [name, ...rest] = relative.split(path.sep);
			if (name) names.add(`${name}${rest.length > 0 ? "/" : ""}`);
		}
		if (names.size === 0 && entries.length === 0) {
			await fs.access(directory);
		}
		return [...names].slice(0, 200).join("\n");
	}

	/** Return the staged paths relative to the project for review and reporting. */
	paths(): string[] {
		return [...this.files.keys()].map((target) => path.relative(this.root, target));
	}

	/** Apply only if every authorized source still matches what the worker read. */
	async apply(assertActive?: () => void): Promise<string[]> {
		const entries = [...this.files];
		for (const [target, staged] of entries) {
			assertActive?.();
			projectPath(this.root, target);
			await this.assertUnchanged(target, staged.before);
		}
		const applied: string[] = [];
		for (const [target, staged] of entries) {
			try {
				assertActive?.();
				await fs.mkdir(path.dirname(target), { recursive: true });
				projectPath(this.root, target);
				await this.assertUnchanged(target, staged.before);
				const mode = (
					await fs.stat(target).catch((error: NodeJS.ErrnoException) => {
						if (error.code === "ENOENT") return undefined;
						throw error;
					})
				)?.mode;
				const temporary = `${target}.pi-team-${randomUUID()}.tmp`;
				try {
					await fs.writeFile(temporary, staged.content, { flag: "wx", mode: mode ?? 0o600 });
					await fs.rename(temporary, target);
				} finally {
					await fs.rm(temporary, { force: true });
				}
				applied.push(path.relative(this.root, target));
			} catch (error) {
				throw new Error(
					`Failed to apply ${path.relative(this.root, target)}; already applied: ${JSON.stringify(applied)}`,
					{
						cause: error,
					},
				);
			}
		}
		return applied;
	}

	private async assertUnchanged(target: string, before: Buffer | undefined): Promise<void> {
		const current = await this.readCurrent(target);
		if (
			(current === undefined) !== (before === undefined) ||
			(current !== undefined && before !== undefined && !current.equals(before))
		) {
			throw new Error(`File changed during assignment: ${path.relative(this.root, target)}`);
		}
	}

	private async readCurrent(target: string): Promise<Buffer | undefined> {
		try {
			const file = await fs.readFile(target);
			if (file.length > 1024 * 1024) throw new Error("File exceeds 1 MiB");
			return file;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}
}
