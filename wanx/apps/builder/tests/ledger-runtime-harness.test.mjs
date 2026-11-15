import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

for (const edition of ['personal-client', 'team-client']) {
  for (const missing of [true, false]) {
    test(`${edition}: fixture ${missing ? 'spawn failure' : 'early exit'} reports immediately`, { timeout: 5000 }, async t => {
      const { startLedgerRuntime } = await import(`../../${edition}/tests/ledger-runtime-harness.mjs`);
      const root = await mkdtemp(path.join(os.tmpdir(), 'ledger-harness-'));
      const previous = process.env.WANX_LEDGER_TEST_PYTHON;
      process.env.WANX_LEDGER_TEST_PYTHON = missing ? path.join(root, 'missing-python') : process.execPath;
      t.after(async () => {
        if (previous === undefined) delete process.env.WANX_LEDGER_TEST_PYTHON;
        else process.env.WANX_LEDGER_TEST_PYTHON = previous;
        await rm(root, { recursive: true, force: true });
      });
      await assert.rejects(startLedgerRuntime(t), missing ? { code: 'ENOENT' } : /Synthetic authority exited before response:.*\S/s);
    });
  }
}
