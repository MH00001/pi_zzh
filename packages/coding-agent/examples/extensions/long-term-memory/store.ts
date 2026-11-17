// Cross-session memory storage, validation, and bounded retrieval.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import lockfile from "proper-lockfile";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
	buildProjectSummary,
	type ProjectSummary,
	parseProjectSummary,
	projectSearchText,
	projectSynopsis,
	renderProjectSummary,
} from "./project-summary.ts";

const execFileAsync = promisify(execFile);
const scopeSchema = Type.Union([Type.Literal("user"), Type.Literal("repo")]);
const kindSchema = Type.Union([
	Type.Literal("preference"),
	Type.Literal("milestone"),
	Type.Literal("transition"),
	Type.Literal("decision"),
	Type.Literal("project_fact"),
	Type.Literal("lesson"),
]);
const verificationSchema = Type.Union([
	Type.Literal("explicit"),
	Type.Literal("user_reported"),
	Type.Literal("tool_observed"),
	Type.Literal("verified_local"),
	Type.Literal("inferred"),
]);
const sourceSchema = Type.Object(
	{
		origin: Type.Union([Type.Literal("command"), Type.Literal("user"), Type.Literal("tool")]),
		sessionId: Type.String({ minLength: 1, maxLength: 128 }),
		entryId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
		at: Type.String(),
	},
	{ additionalProperties: false },
);
const recordSchema = Type.Object(
	{
		id: Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" }),
		scope: scopeSchema,
		kind: kindSchema,
		topic: Type.String({ minLength: 1, maxLength: 80 }),
		fact: Type.String({ minLength: 1, maxLength: 500 }),
		appliesWhen: Type.Optional(Type.String({ maxLength: 160 })),
		occurredAt: Type.Optional(Type.String()),
		recordedAt: Type.String(),
		updatedAt: Type.String(),
		reviewAfter: Type.Optional(Type.String()),
		expiresAt: Type.Optional(Type.String()),
		status: Type.Union([Type.Literal("active"), Type.Literal("pending"), Type.Literal("superseded")]),
		supersededBy: Type.Optional(Type.String()),
		supersededAt: Type.Optional(Type.String()),
		supersededReason: Type.Optional(Type.String({ maxLength: 300 })),
		verification: verificationSchema,
		sources: Type.Array(sourceSchema, { minItems: 1, maxItems: 20 }),
	},
	{ additionalProperties: false },
);

export type MemoryScope = Static<typeof scopeSchema>;
export type MemoryKind = Static<typeof kindSchema>;
export type MemoryVerification = Static<typeof verificationSchema>;
export type MemorySource = Static<typeof sourceSchema>;
export type MemoryRecord = Static<typeof recordSchema>;
export type MemoryInput = Pick<
	MemoryRecord,
	"scope" | "kind" | "topic" | "fact" | "appliesWhen" | "occurredAt" | "verification"
> & { source: MemorySource };

export type MemoryComparison =
	| { action: "add" }
	| { action: "merge"; id: string }
	| { action: "replace"; ids: string[]; reason: string }
	| { action: "skip"; reason: string };
export type MemoryComparator = (input: MemoryInput, records: MemoryRecord[]) => Promise<MemoryComparison>;

export type MemoryState = "active" | "pending" | "review" | "expired" | "superseded";

const MAX_RECORDS_PER_SCOPE = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

function afterDays(time: string, days: number): string {
	return new Date(Date.parse(time) + days * DAY_MS).toISOString();
}

function deadlines(kind: MemoryKind, status: MemoryRecord["status"], verification: MemoryVerification, since: string) {
	if (status === "pending") return { reviewAfter: undefined, expiresAt: afterDays(since, 30) };
	if (kind === "project_fact" || kind === "lesson") {
		return { reviewAfter: afterDays(since, 30), expiresAt: afterDays(since, 90) };
	}
	if (kind === "decision") return { reviewAfter: afterDays(since, 90), expiresAt: undefined };
	if (kind === "preference" && verification === "inferred") {
		return { reviewAfter: afterDays(since, 90), expiresAt: afterDays(since, 180) };
	}
	return { reviewAfter: undefined, expiresAt: undefined };
}

/** Classify a stored fact without mutating it; old records inherit the current retention policy. */
export function memoryState(record: MemoryRecord, now = Date.now()): MemoryState {
	if (record.status === "superseded") return "superseded";
	const fallback = deadlines(record.kind, record.status, record.verification, record.updatedAt);
	const expiresAt = record.expiresAt ?? fallback.expiresAt;
	if (expiresAt && Date.parse(expiresAt) <= now) return "expired";
	if (record.status === "pending") return "pending";
	const reviewAfter = record.reviewAfter ?? fallback.reviewAfter;
	return reviewAfter && Date.parse(reviewAfter) <= now ? "review" : "active";
}
const SECRET_PATTERNS = [
	/\bsk-[A-Za-z0-9._-]{16,}\b/i,
	/\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{20,}\b/i,
	/\bAKIA[A-Z0-9]{16}\b/,
	/\bAIza[A-Za-z0-9_-]{25,}\b/,
	/\bBearer\s+[A-Za-z0-9._~+/-]{16,}\b/i,
	/\b(?:api[_ -]?key|access[_ -]?token|password|secret)\s*[:=]\s*\S{8,}/i,
];

export function containsSecret(text: string): boolean {
	return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

export function redactSecrets(text: string): string {
	let redacted = text;
	for (const pattern of SECRET_PATTERNS) {
		redacted = redacted.replace(new RegExp(pattern.source, `${pattern.flags}g`), "[REDACTED]");
	}
	return redacted;
}

function normalizedFact(fact: string): string {
	return fact.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

function sameFact(record: MemoryRecord, input: MemoryInput): boolean {
	return (
		record.kind === input.kind &&
		normalizedFact(record.fact) === normalizedFact(input.fact) &&
		normalizedFact(record.appliesWhen ?? "") === normalizedFact(input.appliesWhen ?? "") &&
		((record.kind !== "milestone" && record.kind !== "transition") || record.occurredAt === input.occurredAt)
	);
}

function validEventTime(value: string): boolean {
	const match = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(value);
	if (!match || !Number.isFinite(Date.parse(value))) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const calendar = new Date(Date.UTC(year, month - 1, day));
	return calendar.getUTCFullYear() === year && calendar.getUTCMonth() + 1 === month && calendar.getUTCDate() === day;
}

function words(text: string): Set<string> {
	const tokens = new Set<string>();
	for (const match of text.toLocaleLowerCase().matchAll(/[a-z0-9_]{2,}|\p{Script=Han}+/gu)) {
		const value = match[0];
		if (!/\p{Script=Han}/u.test(value)) {
			tokens.add(value);
			continue;
		}
		for (let i = 0; i + 1 < value.length; i++) tokens.add(value.slice(i, i + 2));
	}
	return tokens;
}

export function searchMemories(records: MemoryRecord[], query: string, limit = 5): MemoryRecord[] {
	const queryWords = words(query);
	return records
		.filter((record) => {
			const state = memoryState(record);
			return state === "active" || state === "review";
		})
		.map((record) => {
			const recordWords = words(`${record.topic} ${record.fact} ${record.appliesWhen ?? ""}`);
			let score = 0;
			for (const word of queryWords) if (recordWords.has(word)) score += 4;
			return { record, score };
		})
		.filter(({ score }) => score > 0)
		.sort((a, b) => b.score - a.score || b.record.updatedAt.localeCompare(a.record.updatedAt))
		.slice(0, limit)
		.map(({ record }) => record);
}

async function atomicWrite(filename: string, content: string): Promise<void> {
	const temporary = `${filename}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
		await rename(temporary, filename);
	} finally {
		await rm(temporary, { force: true });
	}
}

/** Resolve one repository identity shared by its main checkout and Git worktrees. */
export async function repositoryIdentity(cwd: string): Promise<{ key: string; name: string }> {
	let identity: string;
	let name: string;
	try {
		const { stdout } = await execFileAsync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
			cwd,
			windowsHide: true,
		});
		const commonDir = path.resolve(stdout.trim());
		identity = `git:${commonDir}`;
		name =
			path.basename(commonDir).toLocaleLowerCase() === ".git"
				? path.basename(path.dirname(commonDir))
				: path.basename(commonDir).replace(/\.git$/i, "");
	} catch {
		identity = `directory:${path.resolve(cwd)}`;
		name = path.basename(path.resolve(cwd));
	}
	if (process.platform === "win32") identity = identity.toLocaleLowerCase();
	return { key: createHash("sha256").update(identity).digest("hex").slice(0, 24), name };
}

/** Get the shared key used by all worktrees of one repository. */
export async function repositoryKey(cwd: string): Promise<string> {
	return (await repositoryIdentity(cwd)).key;
}

/** Persist small, sourced facts outside individual Pi session files. */
export class MemoryStore {
	readonly root: string;
	readonly repoKey: string;
	readonly projectName: string;

	constructor(root: string, repoKey: string, projectName = repoKey) {
		this.root = root;
		this.repoKey = repoKey;
		this.projectName = projectName;
	}

	private scopeDir(scope: MemoryScope, repoKey = this.repoKey): string {
		return scope === "user" ? path.join(this.root, "user") : path.join(this.root, "repos", repoKey);
	}

	private async withLock<T>(scope: MemoryScope, action: (dir: string) => Promise<T>): Promise<T> {
		const dir = this.scopeDir(scope);
		await mkdir(path.join(dir, "records"), { recursive: true });
		const release = await lockfile.lock(dir, {
			realpath: false,
			stale: 30_000,
			retries: { retries: 8, factor: 1.5, minTimeout: 25, maxTimeout: 300 },
		});
		try {
			return await action(dir);
		} finally {
			await release();
		}
	}

	private async readScope(scope: MemoryScope, repoKey = this.repoKey): Promise<MemoryRecord[]> {
		const dir = path.join(this.scopeDir(scope, repoKey), "records");
		let files: string[];
		try {
			files = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const records: MemoryRecord[] = [];
		for (const name of files) {
			const value: unknown = JSON.parse(await readFile(path.join(dir, name), "utf8"));
			if (!Value.Check(recordSchema, value)) throw new Error(`Invalid memory record: ${name}`);
			records.push(value);
		}
		return records;
	}

	async list(): Promise<MemoryRecord[]> {
		const [user, repo] = await Promise.all([this.readScope("user"), this.readScope("repo")]);
		return [...user, ...repo].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	async find(id: string): Promise<MemoryRecord | undefined> {
		return (await this.list()).find((record) => record.id === id);
	}

	async search(query: string, limit = 5): Promise<MemoryRecord[]> {
		return searchMemories(await this.list(), query, limit);
	}

	private projectDir(): string {
		return path.join(this.root, "user", "projects");
	}

	private async readProjectSummaries(): Promise<ProjectSummary[]> {
		let files: string[];
		try {
			files = (await readdir(this.projectDir())).filter((name) => /^[0-9a-f]{24}\.json$/.test(name));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const summaries: ProjectSummary[] = [];
		for (const file of files) {
			let content: string;
			try {
				content = await readFile(path.join(this.projectDir(), file), "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			const value: unknown = JSON.parse(content);
			const summary = parseProjectSummary(value);
			if (`${summary.repoKey}.json` !== file) throw new Error(`Project summary key mismatch: ${file}`);
			summaries.push(summary);
		}
		return summaries;
	}

	async listProjects(): Promise<ProjectSummary[]> {
		return (await this.readProjectSummaries()).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
	}

	async projectSummary(key = this.repoKey): Promise<ProjectSummary | undefined> {
		if (!/^[0-9a-f]{24}$/.test(key)) throw new Error("Invalid project memory key");
		try {
			const value: unknown = JSON.parse(await readFile(path.join(this.projectDir(), `${key}.json`), "utf8"));
			const summary = parseProjectSummary(value);
			if (summary.repoKey !== key) throw new Error("Project summary key mismatch");
			return buildProjectSummary(key, summary.name, await this.readScope("repo", key), memoryState);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	async findProjectRecord(key: string, id: string): Promise<MemoryRecord | undefined> {
		if (
			!/^[0-9a-f]{24}$/.test(key) ||
			!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
		)
			throw new Error("Invalid project memory identifier");
		try {
			const value: unknown = JSON.parse(
				await readFile(path.join(this.root, "repos", key, "records", `${id}.json`), "utf8"),
			);
			if (!Value.Check(recordSchema, value) || value.id !== id || value.scope !== "repo")
				throw new Error("Invalid project memory record");
			return value;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	async searchProjects(query: string, limit = 3): Promise<ProjectSummary[]> {
		const queryWords = words(query);
		const normalizedQuery = query.trim().toLocaleLowerCase();
		return (await this.listProjects())
			.map((summary) => {
				const summaryWords = words(projectSearchText(summary));
				let score = summary.repoKey === normalizedQuery ? 100 : 0;
				if (normalizedQuery && summary.name.toLocaleLowerCase().includes(normalizedQuery)) score += 20;
				for (const word of queryWords) if (summaryWords.has(word)) score += 4;
				return { summary, score };
			})
			.filter(({ score }) => score > 0)
			.sort((a, b) => b.score - a.score || b.summary.lastActivityAt.localeCompare(a.summary.lastActivityAt))
			.slice(0, limit)
			.map(({ summary }) => summary);
	}

	private async writeProjectSummary(): Promise<void> {
		const records = await this.readScope("repo");
		const summary = buildProjectSummary(this.repoKey, this.projectName, records, memoryState);
		const localFile = path.join(this.scopeDir("repo"), "PROJECT_MEMORY.md");
		if (summary) await atomicWrite(localFile, renderProjectSummary(summary));
		else await rm(localFile, { force: true });
		await this.withLock("user", async () => {
			await mkdir(this.projectDir(), { recursive: true });
			const globalFile = path.join(this.projectDir(), `${this.repoKey}.json`);
			if (summary) await atomicWrite(globalFile, `${JSON.stringify(summary, null, 2)}\n`);
			else await rm(globalFile, { force: true });
			const projects = await this.listProjects();
			const lines = ["# Known projects", "", "Generated from sourced repository memories.", ""];
			for (const project of projects) lines.push(`- ${projectSynopsis(project)}`);
			await atomicWrite(path.join(this.root, "user", "PROJECTS.md"), `${lines.join("\n")}\n`);
			await this.writeIndex("user");
		});
	}

	private async writeRecord(record: MemoryRecord): Promise<void> {
		await atomicWrite(
			path.join(this.scopeDir(record.scope), "records", `${record.id}.json`),
			`${JSON.stringify(record, null, 2)}\n`,
		);
	}

	private async writeIndex(scope: MemoryScope): Promise<void> {
		const records = (await this.readScope(scope))
			.filter((record) => memoryState(record) === "active")
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
			.slice(0, 100);
		const lines = [
			"# Pi long-term memory",
			"",
			"Generated index. Use /memory show <id> for evidence and details.",
			"",
		];
		for (const record of records) {
			const time = record.occurredAt ? `occurred ${record.occurredAt}` : `recorded ${record.recordedAt}`;
			lines.push(`- ${record.id} [${record.kind}; ${time}] ${record.fact.slice(0, 160)}`);
		}
		if (scope === "user") {
			const projects = await this.listProjects();
			lines.push("", "## Projects", "", "Use /memory project <key> to read a project summary.");
			for (const project of projects) lines.push(`- ${projectSynopsis(project)}`);
		}
		await atomicWrite(path.join(this.scopeDir(scope), "MEMORY.md"), `${lines.join("\n")}\n`);
	}

	private async audit(scope: MemoryScope, action: string, id: string): Promise<void> {
		await appendFile(
			path.join(this.scopeDir(scope), "events.jsonl"),
			`${JSON.stringify({ at: new Date().toISOString(), action, id })}\n`,
			{ encoding: "utf8", mode: 0o600 },
		);
	}

	async remember(input: MemoryInput, compare?: MemoryComparator): Promise<MemoryRecord> {
		const fact = input.fact.replace(/\s+/g, " ").trim();
		const topic = input.topic.trim().toLocaleLowerCase();
		if (!fact || fact.length > 500 || !topic || topic.length > 80) throw new Error("Memory fact or topic is invalid");
		if (containsSecret(fact) || containsSecret(input.appliesWhen ?? ""))
			throw new Error("Memory contains a likely secret");
		if (!Number.isFinite(Date.parse(input.source.at))) throw new Error("Memory source time is invalid");
		if (input.occurredAt && !validEventTime(input.occurredAt)) throw new Error("Event time is invalid");
		const snapshot = await this.readScope(input.scope);
		const eligible = snapshot.filter((item) => item.status !== "superseded" && memoryState(item) !== "expired");
		const replayed = snapshot.some(
			(item) =>
				sameFact(item, input) &&
				input.source.entryId !== undefined &&
				item.sources.some(
					(source) => source.sessionId === input.source.sessionId && source.entryId === input.source.entryId,
				),
		);
		const needsComparison =
			compare && !replayed && eligible.length > 0 && !eligible.some((item) => sameFact(item, input));
		// Keep provider latency outside the file lock; validate the snapshot again before applying its decision.
		const revision = JSON.stringify(snapshot);
		const comparison: MemoryComparison = needsComparison ? await compare(input, eligible) : { action: "add" };
		if (comparison.action === "skip") throw new Error(`Memory needs review: ${comparison.reason}`);
		return this.withLock(input.scope, async () => {
			const records = await this.readScope(input.scope);
			if (compare && !replayed && JSON.stringify(records) !== revision)
				throw new Error("Memory changed during comparison; retry the save against the latest records");
			// Replayed extraction from an old session must not reactivate a superseded fact.
			const replay = records.find(
				(item) =>
					sameFact(item, input) &&
					input.source.entryId !== undefined &&
					item.sources.some(
						(source) => source.sessionId === input.source.sessionId && source.entryId === input.source.entryId,
					),
			);
			if (replay) return replay;
			let existing = records.find((item) => item.status !== "superseded" && sameFact(item, input));
			if (comparison.action === "merge") {
				existing = records.find((item) => item.id === comparison.id);
				if (
					!existing ||
					existing.status === "superseded" ||
					memoryState(existing) === "expired" ||
					existing.kind !== input.kind ||
					normalizedFact(existing.appliesWhen ?? "") !== normalizedFact(input.appliesWhen ?? "") ||
					((input.kind === "milestone" || input.kind === "transition") && existing.occurredAt !== input.occurredAt)
				)
					throw new Error("Invalid memory merge target");
			}
			const replaced: MemoryRecord[] = [];
			if (comparison.action === "replace") {
				if (
					!comparison.ids.length ||
					comparison.ids.length > 10 ||
					new Set(comparison.ids).size !== comparison.ids.length ||
					!comparison.reason.trim() ||
					comparison.reason.length > 300 ||
					containsSecret(comparison.reason) ||
					input.kind === "milestone" ||
					input.kind === "transition" ||
					input.verification === "inferred" ||
					input.verification === "tool_observed" ||
					input.source.origin === "tool"
				)
					throw new Error(
						"Memory replacement requires a supported current fact, not an inference or historical event",
					);
				for (const id of comparison.ids) {
					const previous = records.find((item) => item.id === id);
					if (
						!previous ||
						previous.id === existing?.id ||
						previous.status === "superseded" ||
						memoryState(previous) === "expired" ||
						previous.kind === "milestone" ||
						previous.kind === "transition" ||
						normalizedFact(previous.appliesWhen ?? "") !== normalizedFact(input.appliesWhen ?? "")
					)
						throw new Error("Invalid memory conflict target or applicability");
					if (previous.sources.some((source) => Date.parse(source.at) > Date.parse(input.source.at)))
						throw new Error("Older evidence cannot supersede a newer memory");
					replaced.push(previous);
				}
			}
			const now = new Date().toISOString();
			let record: MemoryRecord;
			if (existing) {
				if (existing.sources.some((source) => Date.parse(source.at) > Date.parse(input.source.at))) return existing;
				const sameSource = existing.sources.some(
					(source) =>
						input.source.entryId !== undefined &&
						source.sessionId === input.source.sessionId &&
						source.entryId === input.source.entryId,
				);
				if (sameSource) return existing;
				const sources = [...existing.sources, input.source].slice(-20);
				const independentSessions = new Set(sources.map((source) => source.sessionId)).size;
				const status =
					input.verification === "explicit" ||
					existing.kind !== "preference" ||
					(existing.kind === "preference" && independentSessions >= 2) ||
					existing.status === "active"
						? "active"
						: "pending";
				const verification = input.verification === "explicit" ? "explicit" : existing.verification;
				record = {
					...existing,
					topic: input.verification === "explicit" && !topic.startsWith("manual_") ? topic : existing.topic,
					sources,
					updatedAt: now,
					status,
					verification,
					...deadlines(existing.kind, status, verification, now),
				};
			} else {
				if (records.length >= MAX_RECORDS_PER_SCOPE) throw new Error("Memory scope is full; review old records");
				const status = input.kind === "preference" && input.verification === "inferred" ? "pending" : "active";
				record = {
					id: randomUUID(),
					scope: input.scope,
					kind: input.kind,
					topic,
					fact,
					...(input.appliesWhen ? { appliesWhen: input.appliesWhen.slice(0, 160) } : {}),
					...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
					recordedAt: now,
					updatedAt: now,
					status,
					verification: input.verification,
					sources: [input.source],
					...deadlines(input.kind, status, input.verification, now),
				};
			}
			await this.writeRecord(record);
			await this.audit(input.scope, existing ? "update" : "add", record.id);
			for (const previous of replaced) {
				await this.writeRecord({
					...previous,
					status: "superseded",
					supersededBy: record.id,
					supersededAt: now,
					supersededReason: comparison.action === "replace" ? comparison.reason : undefined,
				});
				await this.audit(input.scope, "supersede", previous.id);
			}
			await this.writeIndex(input.scope);
			if (input.scope === "repo") await this.writeProjectSummary();
			return record;
		});
	}

	async edit(id: string, fact: string, sessionId: string): Promise<MemoryRecord> {
		const current = await this.find(id);
		if (!current) throw new Error(`Memory not found: ${id}`);
		const trimmed = fact.replace(/\s+/g, " ").trim();
		if (!trimmed || trimmed.length > 500 || containsSecret(trimmed))
			throw new Error("Memory fact is invalid or sensitive");
		return this.withLock(current.scope, async () => {
			const latest = (await this.readScope(current.scope)).find((record) => record.id === id);
			if (!latest) throw new Error(`Memory not found: ${id}`);
			if (latest.status === "superseded") throw new Error("Superseded memory cannot be edited; add a new fact");
			const now = new Date().toISOString();
			const updated: MemoryRecord = {
				...latest,
				fact: trimmed,
				updatedAt: now,
				status: "active",
				verification: "explicit",
				sources: [...latest.sources, { origin: "command" as const, sessionId, at: now }].slice(-20),
				...deadlines(latest.kind, "active", "explicit", now),
			};
			await this.writeRecord(updated);
			await this.audit(current.scope, "edit", id);
			await this.writeIndex(current.scope);
			if (current.scope === "repo") await this.writeProjectSummary();
			return updated;
		});
	}

	async renew(id: string, sessionId: string): Promise<MemoryRecord> {
		const current = await this.find(id);
		if (!current) throw new Error(`Memory not found: ${id}`);
		return this.withLock(current.scope, async () => {
			const latest = (await this.readScope(current.scope)).find((record) => record.id === id);
			if (!latest) throw new Error(`Memory not found: ${id}`);
			if (latest.status === "superseded") throw new Error("Superseded memory cannot be renewed; add a new fact");
			const now = new Date().toISOString();
			const updated: MemoryRecord = {
				...latest,
				updatedAt: now,
				status: "active",
				verification: "explicit",
				sources: [...latest.sources, { origin: "command" as const, sessionId, at: now }].slice(-20),
				...deadlines(latest.kind, "active", "explicit", now),
			};
			await this.writeRecord(updated);
			await this.audit(current.scope, "renew", id);
			await this.writeIndex(current.scope);
			if (current.scope === "repo") await this.writeProjectSummary();
			return updated;
		});
	}

	async pruneExpired(mode: "preview" | "apply" | "pending-only" = "preview"): Promise<MemoryRecord[]> {
		if (mode === "preview") return (await this.list()).filter((record) => memoryState(record) === "expired");
		const pruned: MemoryRecord[] = [];
		for (const scope of ["user", "repo"] as const) {
			await this.withLock(scope, async () => {
				const records = await this.readScope(scope);
				for (const record of records) {
					if (memoryState(record) !== "expired" || (mode === "pending-only" && record.status !== "pending"))
						continue;
					await rm(path.join(this.scopeDir(scope), "records", `${record.id}.json`), { force: true });
					await this.audit(scope, "prune", record.id);
					pruned.push(record);
				}
				await this.writeIndex(scope);
				if (scope === "repo") await this.writeProjectSummary();
			});
		}
		return pruned;
	}

	async forget(id: string): Promise<boolean> {
		const current = await this.find(id);
		if (!current) return false;
		return this.withLock(current.scope, async () => {
			await rm(path.join(this.scopeDir(current.scope), "records", `${id}.json`), { force: true });
			await this.audit(current.scope, "forget", id);
			await this.writeIndex(current.scope);
			if (current.scope === "repo") await this.writeProjectSummary();
			return true;
		});
	}

	async isEnabled(): Promise<boolean> {
		try {
			const value: unknown = JSON.parse(await readFile(path.join(this.root, "settings.json"), "utf8"));
			return !value || typeof value !== "object" || (value as { enabled?: unknown }).enabled !== false;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
			throw error;
		}
	}

	async setEnabled(enabled: boolean): Promise<void> {
		await mkdir(this.root, { recursive: true });
		const release = await lockfile.lock(this.root, { realpath: false, retries: 5 });
		try {
			await atomicWrite(path.join(this.root, "settings.json"), `${JSON.stringify({ enabled }, null, 2)}\n`);
		} finally {
			await release();
		}
	}
}
