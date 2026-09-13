import { describe, expect, test } from "bun:test";

function packagedPaths(value: unknown): string[] {
	if (!Array.isArray(value) || value.length !== 1) throw new Error("npm pack returned an unexpected result");
	const result = value[0];
	if (!result || typeof result !== "object" || !("files" in result) || !Array.isArray(result.files)) {
		throw new Error("npm pack did not return a file list");
	}
	const files: unknown[] = result.files;
	return files.map((file: unknown) => {
		if (!file || typeof file !== "object" || !("path" in file) || typeof file.path !== "string") {
			throw new Error("npm pack returned an invalid file entry");
		}
		return file.path;
	});
}

describe("npm package", () => {
	test("ships every plugin runtime file without the standalone gateway", async () => {
		const process = Bun.spawn(["npm", "pack", "--dry-run", "--json"], {
			cwd: new URL("..", import.meta.url).pathname,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			process.exited,
			new Response(process.stdout).text(),
			new Response(process.stderr).text(),
		]);
		if (exitCode !== 0) throw new Error(`npm pack failed: ${stderr}`);
		const paths = packagedPaths(JSON.parse(stdout));
		expect(paths).toContain("task-duration.ts");
		expect(paths).toContain("webhook-notification.ts");
		expect(paths.some(path => path.startsWith("cf-notify-gateway/"))).toBe(false);
	});
});
