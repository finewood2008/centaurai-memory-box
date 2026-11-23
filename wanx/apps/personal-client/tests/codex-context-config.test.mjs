import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
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

test('discovers the Mac desktop CLI without a shell PATH and preserves explicit PATH precedence', async t => {
  const home = await tempDirectory(t);
  const applications = path.join(home, 'Applications');
  const bundled = path.join(applications, 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex');
  const external = path.join(home, 'bin', 'codex');
  for (const file of [bundled, external]) {
    await mkdir(path.dirname(file), {recursive: true});
    await writeFile(file, 'fixture', {mode: 0o700});
  }
  const options = {platform: 'darwin', home, macApplicationDirectories: [applications]};
  assert.equal(await findCodexCli({...options, env: {PATH: '/usr/bin:/bin'}}), bundled);
  assert.equal(await findCodexCli({...options, env: {PATH: path.dirname(external)}}), external);
});

test('discovers a Mac user CLI outside the desktop PATH', async t => {
  const home = await tempDirectory(t);
  const executable = path.join(home, '.local', 'bin', 'codex');
  await mkdir(path.dirname(executable), {recursive: true});
  await writeFile(executable, 'fixture', {mode: 0o700});
  assert.equal(await findCodexCli({platform: 'darwin', home, macApplicationDirectories: [],
    env: {PATH: '/usr/bin:/bin'}}), executable);
});

test('Codex MCP commands receive the Mac CLI runtime PATH and keep CODEX_HOME', async t => {
  const directory = await tempDirectory(t);
  const env = {PATH: '/usr/bin:/bin', CODEX_HOME: directory};
  const config = createCodexContextConfig({stdioPath, descriptorPath: path.join(directory, 'endpoint.json'), env, platform: 'darwin',
    discover: async options => {
      assert.equal(options.env, env);
      return path.join(directory, 'codex');
    },
    run: async (_cli, args, options) => {
      assert.deepEqual(args, ['mcp', 'list', '--json']);
      assert.equal(options.env.CODEX_HOME, directory);
      const directories = options.env.PATH.split(':');
      assert.deepEqual(directories.slice(0, 2), ['/usr/bin', '/bin']);
      assert.ok(directories.includes('/opt/homebrew/bin'));
      assert.ok(directories.includes('/usr/local/bin'));
      return {stdout: '[]'};
    },
  });
  assert.equal(await config.isConfigured(), false);
});

test('registers only if the name is free and preserves replaced or disabled configuration', async () => {
  const environment = {CODEX_HOME: path.join(tmpdir(), 'wanx-fixture')};
  const descriptorPath = path.join(tmpdir(), 'wanx-test-descriptor.json');
  const cli = path.join(tmpdir(), 'codex.exe');
  const commands = [];
  const transport = {type: 'stdio', command: process.execPath, args: [stdioPath, descriptorPath], env: {ELECTRON_RUN_AS_NODE: '1'}};
  let entries = [];
  const config = createCodexContextConfig({
    stdioPath, descriptorPath, env: environment, platform: 'linux',
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
  assert.deepEqual(await Promise.all([config.ensure(), config.ensure()]), [
    {configurationChanged: true}, {configurationChanged: true},
  ]);
  assert.equal(await config.isConfigured(), true);
  assert.deepEqual(await config.ensure(), {configurationChanged: false});
  assert.deepEqual(commands.filter(args => args[1] === 'add'), [['mcp', 'add', 'wanx-memobox', '--env', 'ELECTRON_RUN_AS_NODE=1', '--', process.execPath, stdioPath, descriptorPath]]);
  entries = [{name: 'wanx-memobox', enabled: true, transport: {type: 'streamable_http'}}];
  await assert.rejects(config.ensure(), /已被占用/);
  entries = [{name: 'wanx-memobox', enabled: false, transport}];
  await assert.rejects(config.ensure(), /已禁用/);
  assert.equal(commands.filter(args => args[1] === 'add').length, 1);
});

test('the installed Mac Codex bridge migrates the same profile and keeps a stable command after the app moves', async t => {
  const profile = path.join(await tempDirectory(t), 'codex-context');
  const descriptorPath = path.join(profile, 'endpoint.json');
  const launcher = path.join(profile, 'stdio-launcher.sh');
  const commands = [];
  let transport = {type: 'stdio', command: process.execPath, args: [stdioPath, descriptorPath], env: {ELECTRON_RUN_AS_NODE: '1'}};
  const options = {stdioPath, descriptorPath, platform: 'darwin', stableLauncher: true, discover: async () => '/test/codex',
    async run(_cli, args) {
      if (args[1] === 'list') return {stdout: JSON.stringify([{name: 'wanx-memobox', transport, enabled: true}])};
      commands.push(args);
      transport = {type: 'stdio', command: '/bin/sh', args: [launcher]};
      return {stdout: ''};
    },
  };
  const original = createCodexContextConfig(options);
  assert.equal(await original.restore(() => {}), true);
  assert.equal(await original.isConfigured(), true);
  assert.deepEqual(commands, [['mcp', 'add', 'wanx-memobox', '--', '/bin/sh', launcher]]);
  const executable = path.join(profile, '新版.app', 'Contents', 'MacOS', '客户端');
  const moved = createCodexContextConfig({...options, executable});
  assert.equal(await moved.isConfigured(), false);
  assert.equal(await moved.restore(() => {}), true);
  assert.equal(await moved.isConfigured(), true);
  assert.ok((await readFile(launcher, 'utf8')).includes(executable));
  assert.equal(commands.length, 1);
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
