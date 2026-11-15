// Optional qualification uses WANX's actual NativeSession and a supplied binary.
import { readFileSync } from 'node:fs';
import { NativeSession } from '../../../apps/builder/codex/native-session.mjs';

const input = JSON.parse(readFileSync(0, 'utf8'));
const config = JSON.parse(input.environment.WANX_CODEX_CONFIG);
const session = new NativeSession({
  binary: input.environment.WANX_CODEX_PATH, config,
  env: { ...process.env, ...input.environment },
});
process.once('SIGTERM', async () => { await session.close(); process.exit(1); });
try {
  await session.open({ cwd: input.cwd, scope: 'synthetic-default-qualification', mcpServers: {} });
  const turn = await session.prompt([{ type: 'text', text: 'Synthetic qualification only. Reply with ok. Do not use tools.' }]);
  process.stdout.write(JSON.stringify({ completed: turn.status === 'completed' }));
} catch (error) {
  process.stderr.write(String(error.message || 'CODEX_QUALIFICATION_FAILED'));
  process.exitCode = 1;
} finally { await session.close(); }
