import path from "node:path";
import { spawn } from "node:child_process";
import { withSanitizedNodeOptions } from "./sanitize-node-options.mjs";

const cwd = process.cwd();
const vitestBin = path.join(cwd, "node_modules", "vitest", "vitest.mjs");
const testEnvironment = withSanitizedNodeOptions(process.env);
for (const name of Object.keys(testEnvironment)) {
	if (/(?:AUTH_TOKEN|CT0|API_KEY|TOKEN|SECRET|PASSWORD|COOKIE)/iu.test(name)) {
		delete testEnvironment[name];
	}
}

const child = spawn(process.execPath, [vitestBin, ...process.argv.slice(2)], {
	cwd,
	stdio: "inherit",
	env: testEnvironment,
});

child.on("exit", (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}

	process.exit(code ?? 0);
});
