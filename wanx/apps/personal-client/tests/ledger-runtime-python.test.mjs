import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function interpreter(file, identity) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `#!${process.execPath}
const { createInterface } = require('node:readline');
process.stdout.write(JSON.stringify({ type: 'ready', interpreter: ${JSON.stringify(identity)} }) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
  if (JSON.parse(line).operation === 'stop') process.exit(0);
});
`, { mode: 0o755 });
}

for (const edition of ['personal-client', 'team-client']) {
  test(`${edition} ledger fixtures use project environments and honor explicit interpreters`, {
    skip: process.platform === 'win32',
  }, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wanx ledger python-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const harness = path.join(root, 'apps', edition, 'tests', 'ledger-runtime-harness.mjs');
    await mkdir(path.dirname(harness), { recursive: true });
    await copyFile(new URL(`../../${edition}/tests/ledger-runtime-harness.mjs`, import.meta.url), harness);
    const environments = {
      octop: path.join(root, 'octop', '.venv', 'bin', 'python'),
      bridge: path.join(root, 'server', 'bridge', '.venv', 'bin', 'python'),
      legacy: path.join(root, '.venv', 'bin', 'python'),
      general: path.join(root, 'overrides', 'general python'),
      ledger: path.join(root, 'overrides', 'ledger python'),
    };
    for (const [identity, file] of Object.entries(environments)) await interpreter(file, identity);
    const { startLedgerRuntime } = await import(pathToFileURL(harness));
    const keys = ['WANX_LEDGER_TEST_PYTHON', 'WANX_TEST_PYTHON'];
    const previous = keys.map(key => process.env[key]);
    t.after(() => {
      for (const [index, key] of keys.entries()) {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      }
    });
    const cases = [
      [{}, {}, 'bridge'],
      [{ backup: true }, {}, 'octop'],
      [{ transfer: true }, {}, 'octop'],
      ...(edition === 'team-client' ? [[{ team: true }, {}, 'bridge']] : []),
      [{ backup: true }, { WANX_TEST_PYTHON: environments.general }, 'general'],
      [{ transfer: true }, {
        WANX_TEST_PYTHON: environments.general,
        WANX_LEDGER_TEST_PYTHON: environments.ledger,
      }, 'ledger'],
    ];
    for (const [options, overrides, expected] of cases) {
      for (const key of keys) {
        if (overrides[key] === undefined) delete process.env[key];
        else process.env[key] = overrides[key];
      }
      const runtime = await startLedgerRuntime(t, options);
      try {
        assert.equal(runtime.interpreter, expected, JSON.stringify(options));
      } finally {
        await runtime.close();
      }
    }
  });
}
