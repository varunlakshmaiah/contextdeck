import { execFile } from "node:child_process";

/** Runs a program (no shell), optionally feeding stdin. Rejects with stderr attached. */
export function run(cmd: string, args: string[], opts: { timeout?: number; input?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile(cmd, args, { timeout: opts.timeout ?? 4000, maxBuffer: 8 * 1024 * 1024, env: opts.env ?? process.env, windowsHide: true }, (err, stdout, stderr) => {
			if (err) reject(Object.assign(err, { stderr: String(stderr) }));
			else resolve(String(stdout));
		});
		if (opts.input !== undefined) child.stdin?.end(opts.input);
	});
}

export const errText = (e: unknown) => (((e as { stderr?: string }).stderr || (e as Error).message || String(e)).trim()).slice(0, 220);
