import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCodexContextConfig, findCodexCli } from '../shell/codex-context-config.mjs';

const stdioPath = fileURLToPath(new URL('../shell/codex-context-stdio.mjs', import.meta.url));

async function tempDirectory(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'wanx-codex-test-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return directory;
}

test('uses the runnable desktop CLI if Windows PATH has no executable', async t => {
  const directory = await tempDirectory(t);
  const binaryDirectory = path.join(directory, 'OpenAI', 'Codex', 'bin', 'abcdef01');
  await mkdir(binaryDirectory, {recursive: true});
  const executable = path.join(binaryDirectory, 'codex.exe');
  await writeFile(executable, 'fixture');
  assert.equal(await findCodexCli({platform: 'win32', env: {LOCALAPPDATA: directory}}), executable);
});

test('registers only if the name is free and preserves replaced or disabled configuration', async () => {
  const environment = {CODEX_HOME: path.join(tmpdir(), 'wanx-fixture')};
  const descriptorPath = path.join(tmpdir(), 'wanx-test-descriptor.json');
  const cli = path.join(tmpdir(), 'codex.exe');
  const commands = [];
  const transport = {type: 'stdio', command: process.execPath, args: [stdioPath, descriptorPath], env: {ELECTRON_RUN_AS_NODE: '1'}};
  let entries = [];
  const config = createCodexContextConfig({
    stdioPath, descriptorPath, env: environment,
    discover: async () => cli,
    run: async (filename, args, options) => {
      assert.equal(filename, cli);
      assert.equal(options.env, environment);
      commands.push(args);
      if (args[1] === 'list') return {stdout: JSON.stringify(entries)};
      entries = [{name: 'wanx-memobox', enabled: true, transport}];
      return {stdout: ''};
    },
  });
  assert.equal(await config.isConfigured(), false);
  await Promise.all([config.ensure(), config.ensure()]);
  assert.equal(await config.isConfigured(), true);
  await config.ensure();
  assert.deepEqual(commands.filter(args => args[1] === 'add'), [['mcp', 'add', 'wanx-memobox', '--env', 'ELECTRON_RUN_AS_NODE=1', '--', process.execPath, stdioPath, descriptorPath]]);
  entries = [{name: 'wanx-memobox', enabled: true, transport: {type: 'streamable_http'}}];
  await assert.rejects(config.ensure(), /已被占用/);
  entries = [{name: 'wanx-memobox', enabled: false, transport}];
  await assert.rejects(config.ensure(), /已禁用/);
  assert.equal(commands.filter(args => args[1] === 'add').length, 1);
});

test('stdio uses the private loopback descriptor for every call, including after token rotation', {timeout: 10000}, async t => {
  const directory = await tempDirectory(t);
  const descriptor = path.join(directory, 'context.json');
  const observed = [];
  let observeNotification;
  const notified = new Promise(resolve => { observeNotification = resolve; });
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const value = JSON.parse(Buffer.concat(chunks));
    observed.push({url: request.url, auth: request.headers.authorization, value});
    if (!Object.hasOwn(value, 'id')) {
      response.writeHead(204).end();
      observeNotification();
      return;
    }
    response.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify({jsonrpc: '2.0', id: value.id, result: {ok: true}}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const token = 'a'.repeat(64);
  const rotatedToken = 'b'.repeat(64);
  const setToken = token => writeFile(descriptor, JSON.stringify({port: server.address().port, token}));
  await setToken(token);
  const child = spawn(process.execPath, [stdioPath, descriptor], {stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
  t.after(() => child.kill());
  const replies = createInterface({input: child.stdout})[Symbol.asyncIterator]();
  const send = value => child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', ...value})}\n`);
  const reply = async () => JSON.parse((await replies.next()).value);
  send({method: 'initialize', id: 1});
  assert.deepEqual(await reply(), {jsonrpc: '2.0', id: 1, result: {ok: true}});
  send({method: 'notifications/initialized'});
  await notified;
  await setToken(rotatedToken);
  send({method: 'tools/call', id: 'next', params: {name: 'space_search', arguments: {query: '合成资料'}}});
  assert.deepEqual(await reply(), {jsonrpc: '2.0', id: 'next', result: {ok: true}});
  assert.deepEqual(observed.map(call => [call.url, call.auth, call.value.method]), [
    ['/mcp', `Bearer ${token}`, 'initialize'],
    ['/mcp', `Bearer ${token}`, 'notifications/initialized'],
    ['/mcp', `Bearer ${rotatedToken}`, 'tools/call'],
  ]);
  child.stdin.end();
  assert.equal((await replies.next()).done, true);
});
