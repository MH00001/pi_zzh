// Files and messages exposed to team members are bounded at the tool boundary.
import * as fs from "node:fs";
import * as path from "node:path";

export const roles = ["scout", "planner", "worker", "reviewer"] as const;
export type Role = (typeof roles)[number];
export interface Mail {
	from: Role;
	to: Role | "coordinator";
	text: string;
}

export class Mailbox {
	private messages: Mail[] = [];
	send(from: Role, to: Mail["to"], text: string): void {
		if (from === to) throw new Error("Cannot send to yourself");
		if (!text.trim() || text.length > 4000) throw new Error("Message must contain 1–4000 characters");
		if (this.messages.length >= 64) throw new Error("Mailbox full; coordinator must drain messages");
		this.messages.push({ from, to, text });
	}
	drain(to: Mail["to"]): Mail[] {
		const selected = this.messages.filter((m) => m.to === to);
		this.messages = this.messages.filter((m) => m.to !== to);
		return selected;
	}
	list(): Mail[] {
		return this.messages.map((m) => ({ ...m }));
	}
}

export function projectPath(root: string, input: string): string {
	const base = fs.realpathSync(root);
	const target = path.resolve(base, input);
	const relative = path.relative(base, target);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error("Path is outside the project");
	}
	const parts = relative.split(path.sep);
	if (parts.some((p) => /:|[. ]$/.test(p))) throw new Error("Ambiguous path component");
	if (parts.some((p) => /^(\.git|\.pi|\.agents|\.codex|node_modules|\.env(?:\..*)?|auth\.json)$/i.test(p))) {
		throw new Error("Protected path");
	}
	let current = base;
	for (const part of parts) {
		current = path.join(current, part);
		try {
			if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Symlinks are not allowed");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return target;
}
