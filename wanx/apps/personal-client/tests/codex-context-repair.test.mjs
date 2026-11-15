import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { createCodexContextConfig } from '../shell/codex-context-config.mjs';
import { createMyAiAccess } from '../shell/my-ai-access.mjs';

const stdioPath = path.join(tmpdir(), 'new', 'codex-context-stdio.mjs');
const descriptorPath = path.join(tmpdir(), 'new', 'codex-context', 'endpoint.json');
const legacy = () => ({name: 'wanx-memobox', enabled: true, transport: {
  type: 'stdio', command: path.join(tmpdir(), 'old', 'Electron'),
  args: [path.join(tmpdir(), 'old', 'codex-context-stdio.mjs'), path.join(tmpdir(), 'old', 'codex-context', 'endpoint.json')],
  env: {ELECTRON_RUN_AS_NODE: '1'},
}});
function fixture(confirmReplace) {
  let server = legacy(), writes = 0;
  const config = createCodexContextConfig({stdioPath, descriptorPath, confirmReplace, discover: async () => '/fixture/codex',
    run: async (_cli, args) => {
      if (args[1] === 'list') return {stdout: JSON.stringify(server ? [server] : [])};
      writes++;
      server = {name: 'wanx-memobox', enabled: true, transport: {type: 'stdio', command: process.execPath,
        args: [stdioPath, descriptorPath], env: {ELECTRON_RUN_AS_NODE: '1'}}};
      return {stdout: ''};
    },
  });
  return {config, get writes() {return writes;}, get server() {return server;}, set server(value) {server = value;}};
}

test('old installation needs explicit confirmation; confirmed repair coalesces and verifies new paths', async () => {
  let prompts = 0;
  const f = fixture(async details => {
    prompts++;
    assert.deepEqual(details.previous, {command: legacy().transport.command, args: legacy().transport.args});
    assert.deepEqual(details.next, {command: process.execPath, args: [stdioPath, descriptorPath]});
    assert.ok(!JSON.stringify(details).includes('ELECTRON_RUN_AS_NODE'));
    return true;
  });
  assert.equal(await f.config.isConfigured(), false);
  await Promise.all([f.config.ensure(), f.config.ensure()]);
  assert.equal(prompts, 1); assert.equal(f.writes, 1);
  assert.equal(await f.config.isConfigured(), true);
  await f.config.ensure(); assert.equal(f.writes, 1);
});

test('missing confirmation, cancel, foreign transports and disabled bridges never write', async () => {
  let prompts = 0;
  const denied = fixture();
  await assert.rejects(denied.config.ensure(), {code: 'MCP_CONFIG_NAME_CONFLICT'});
  assert.equal(denied.writes, 0);
  const cancelled = fixture(async () => false);
  await assert.rejects(cancelled.config.ensure(), {code: 'CODEX_MCP_REPAIR_CANCELLED'});
  assert.equal(cancelled.writes, 0);
  const foreign = fixture(async () => {prompts++; return true;});
  foreign.server.transport.args[0] = '/another/server.mjs';
  await assert.rejects(foreign.config.ensure(), {code: 'MCP_CONFIG_NAME_CONFLICT'});
  foreign.server = legacy(); foreign.server.transport.env.SECRET = 'fixture-secret';
  await assert.rejects(foreign.config.ensure(), {code: 'MCP_CONFIG_NAME_CONFLICT'});
  foreign.server = legacy(); foreign.server.enabled = false;
  await assert.rejects(foreign.config.ensure(), {code: 'CODEX_MCP_DISABLED'});
  assert.equal(prompts, 0); assert.equal(foreign.writes, 0);
});

test('configuration edits or account changes while confirming prevent replacement', async () => {
  const changed = fixture(async () => {changed.server.transport.command = '/changed/Electron'; return true;});
  await assert.rejects(changed.config.ensure(), {code: 'MCP_CONFIG_CHANGED'});
  assert.equal(changed.writes, 0);
  let active = true;
  const switched = fixture(async () => {active = false; return true;});
  await assert.rejects(switched.config.ensure(() => {if (!active) throw new Error('scope switched');}), /scope switched/);
  assert.equal(switched.writes, 0);
});

test('Codex discovery, read and CLI failures keep distinct public codes', async () => {
  const base = {stdioPath, descriptorPath};
  await assert.rejects(createCodexContextConfig({...base, discover: async () => null}).ensure(), {code: 'CODEX_CLI_NOT_FOUND'});
  await assert.rejects(createCodexContextConfig({...base, discover: async () => '/fixture/codex', run: async () => ({stdout: 'invalid'})}).ensure(), {code: 'CODEX_MCP_READ_FAILED'});
  for (const code of ['EACCES', 'EPERM', 'ENOENT']) {
    await assert.rejects(createCodexContextConfig({...base, discover: async () => '/fixture/codex', run: async () => {throw Object.assign(new Error('private details'), {code});}}).ensure(),
      {code: code === 'ENOENT' ? 'CODEX_MCP_CLI_FAILED' : code});
  }
});

test('My AI shows specific repair/configuration failures without saving connection or leaking raw details', async () => {
  const errors = [
    ['MCP_CONFIG_NAME_CONFLICT', /存在不同/], ['CODEX_CLI_NOT_FOUND', /未找到 Codex CLI/],
    ['CODEX_MCP_DISABLED', /已禁用/], ['CODEX_MCP_REPAIR_CANCELLED', /原来的.*已保留/],
    ['MCP_CONFIG_CHANGED', /其他程序修改/], ['MCP_CONFIG_INVALID', /格式或文件类型/],
    ['CODEX_MCP_CLI_FAILED', /CLI 未能更新/], ['MCP_CONFIG_VERIFY_FAILED', /校验未通过/],
  ];
  for (const [code, message] of errors) {
    let saves = 0;
    const access = createMyAiAccess({agents: ['codex'], owner: () => 'owner', box: () => 'box', scope: () => 'scope', sources: {}, memory: {async ready() {}},
      store: {async load() {return {};}, async save() {saves++;}},
      makeContext: () => ({async manage() {throw Object.assign(new Error('private details'), {code});}, async close() {}}),
    });
    await assert.rejects(access.connect('codex', () => {}), error => message.test(error.message) && !error.message.includes('private details'));
    assert.equal(saves, 0); await access.close();
  }
});

test('real Codex CLI replaces only the confirmed fixture bridge and preserves unrelated configuration', {skip: !process.env.MEMOBOX_TEST_CODEX_CLI}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'memobox-codex-repair-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const file = path.join(directory, 'config.toml');
  await writeFile(file, '# keep this comment\nmodel = "fixture-model"\n[mcp_servers.unrelated]\ncommand = "fixture-other"\n');
  const run = promisify(execFile), cli = process.env.MEMOBOX_TEST_CODEX_CLI;
  const env = {...process.env, CODEX_HOME: directory};
  const old = legacy().transport;
  await run(cli, ['mcp', 'add', 'wanx-memobox', '--env', 'ELECTRON_RUN_AS_NODE=1', '--', old.command, ...old.args], {env});
  const list = async () => JSON.parse((await run(cli, ['mcp', 'list', '--json'], {env})).stdout);
  const unrelated = (await list()).find(row => row.name === 'unrelated');
  let prompts = 0;
  const config = createCodexContextConfig({stdioPath, descriptorPath, env, discover: async () => cli, confirmReplace: async () => {prompts++; return true;}});
  await config.ensure();
  assert.equal(prompts, 1); assert.equal(await config.isConfigured(), true);
  assert.deepEqual((await list()).find(row => row.name === 'unrelated'), unrelated);
  const updated = await readFile(file, 'utf8');
  assert.match(updated, /# keep this comment/); assert.match(updated, /model = "fixture-model"/);
});
