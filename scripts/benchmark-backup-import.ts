import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	exportBackup,
	getBackupDatabaseFingerprint,
	importBackup,
} from "../src/lib/backup";
import { resetBirdclawPathsForTests } from "../src/lib/config";
import { resetDatabaseWriterForTests } from "../src/lib/database-writer";
import { getNativeDb, resetDatabaseForTests } from "../src/lib/db";

// Synthetic data only: never open the caller's database or configured backup.
const root = mkdtempSync(path.join(os.tmpdir(), "birdclaw-backup-benchmark-"));
const previousHome = process.env.BIRDCLAW_HOME;
const previousConfig = process.env.BIRDCLAW_CONFIG;
const rowCount = 10_000;
function switchHome(name: string) {
	resetDatabaseWriterForTests();
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	process.env.BIRDCLAW_HOME = path.join(root, name);
	delete process.env.BIRDCLAW_CONFIG;
	return getNativeDb({ seedDemoData: false });
}

try {
	const source = switchHome("source");
	const insert = source.prepare(`insert into tweet_revisions
		(root_tweet_id, revision_id, revision_index, payload_json, source, observed_at)
		values (?, ?, 0, ?, 'xurl', '2026-01-01T00:00:00.000Z')`);
	source.transaction(() => {
		for (let index = 0; index < rowCount; index++) {
			const id = `singleton-${String(index).padStart(6, "0")}`;
			insert.run(id, id, JSON.stringify({ text: "x".repeat(1024) }));
		}
	})();
	const expected = getBackupDatabaseFingerprint(source);
	const repoPath = path.join(root, "backup");
	await exportBackup({ repoPath, db: source });
	for (let run = 1; run <= 3; run++) {
		const db = switchHome(`destination-${run}`);
		for (const mode of ["replace", "merge"] as const) {
			const started = performance.now();
			const result = await importBackup({ repoPath, db, mode });
			const elapsedMs = Math.round(performance.now() - started);
			assert.deepEqual(result.fingerprint, expected);
			console.log(
				JSON.stringify({
					run,
					mode,
					rowCount,
					elapsedMs,
					hash: result.fingerprint.hash,
				}),
			);
		}
	}
} finally {
	resetDatabaseWriterForTests();
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	if (previousHome === undefined) delete process.env.BIRDCLAW_HOME;
	else process.env.BIRDCLAW_HOME = previousHome;
	if (previousConfig === undefined) delete process.env.BIRDCLAW_CONFIG;
	else process.env.BIRDCLAW_CONFIG = previousConfig;
	rmSync(root, { recursive: true, force: true });
}
