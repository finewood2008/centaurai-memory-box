import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import readline from 'node:readline';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {stopGroup} from '../dsh/sandbox.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

// This substitutes only the external inference process. The worker, native
// transport, MCP tool process and private task proxy are real. It verifies the
// developer handoff, not whether a real model will follow the instructions.
for (const modification of [false, true]) {
test(`standard native ${modification ? 'frozen modification rejects empty delivery' : 'first build accepts unchanged starter'} while delivering material and protecting fixed files`, {timeout: 30000}, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wanx-standard-native-material-'));
  const capture = path.join(dir, 'captured.json');
  const binary = path.join(dir, 'synthetic-codex.mjs');
  const terminal = path.join(dir, 'unavailable-terminal');
  const taskRoot = path.join(dir, 'task');
  await mkdir(path.join(taskRoot, 'shell'), {recursive: true});
  const fixed = {
    'shell/main.cjs': '// Synthetic fixed main; never executed\n',
    'shell/preload.cjs': '// Synthetic fixed preload; never executed\n',
    'shell/host.cjs': '// Synthetic fixed host; never executed\n',
    'project-spec.json': '{"marker":"fixed-project-spec"}\n',
    'application.manifest.json': '{"marker":"fixed-manifest"}\n',
    'generation-manifest.json': '{"marker":"fixed-generation"}\n',
  };
  for (const [name, content] of Object.entries(fixed)) await writeFile(path.join(taskRoot, name), content);
  const files = {
    'app/host.mjs': 'document.querySelector("main").textContent = "Ordinary demo";\n',
    'app/host.html': '<main>Ordinary demo</main>\n',
  };
  const material = {
    instruction: '本轮修改必须读取 record.json，而不是 record.value.json，并保留其他业务行为。',
    executionPackage: {
      schemaVersion: 1,
      changeId: 'synthetic-record-json-fix',
      spec: {goal: '修复恢复保存记录时的扁平 json 字段读取', acceptance: ['保存后重开页面必须恢复原记录内容']},
      contract: {scope: '只修改 app/host.mjs 的记录解析；固定宿主桥和清单保持不变'},
    },
    requestedChange: {
      text: '原始请求独有细节：请将 selectedRecord.value.json 改为 selectedRecord.json。',
      answers: [{questionId: 'synthetic-state-recovery', answer: '原始回答独有细节：解析失败时保留原文本并显示可重试错误。'}],
    },
    solution: {goal: 'Synthetic text expert application'},
    devKit: {
      projectSpecHash: 'a'.repeat(64),
      projectSpec: {schemaVersion: 1, applicationId: 'dev.wanx.synthetic.a12345678', expert: {enabled: true, definitionRef: 'wanx.expert-app.v1'}},
      rendererBridgeContract: {
        schemaVersion: 1,
        methods: ['window.wanx.expertContext()', 'window.wanx.expertInvoke({operation,input})'],
        envelope: '{ok:true,value} or {ok:false,code}',
        fixedFiles: Object.keys(fixed),
      },
    },
    expertInstruction: 'Use the fixed expert bridge; never infer its absence from the demo page.',
  };
  if (!modification) {
    delete material.executionPackage;
    delete material.requestedChange;
  }
  await writeFile(terminal, '#!/usr/bin/env node\nprocess.exit(1);\n', {mode: 0o700});
  await writeFile(binary, `#!/usr/bin/env node
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import readline from 'node:readline';
import {writeFile} from 'node:fs/promises';
import {WebSocketServer} from ${JSON.stringify(import.meta.resolve('ws'))};
const endpoint = process.argv[process.argv.indexOf('--listen') + 1].slice('unix://'.length);
const server = http.createServer(), sockets = new WebSocketServer({server}), threads = new Map();
sockets.on('connection', ws => ws.on('message', async raw => {
  const message = JSON.parse(raw);
  if (message.id === undefined) return;
  const reply = result => ws.send(JSON.stringify({id: message.id, result}));
  if (message.method === 'initialize') { reply({}); return; }
  if (message.method === 'thread/start') {
    const id = randomUUID(); threads.set(id, message.params.config);
    reply({thread: {id}, approvalPolicy: 'never', sandbox: {type: 'readOnly'}}); return;
  }
  if (message.method !== 'turn/start') { reply({}); return; }
  const id = randomUUID(), threadId = message.params.threadId;
  reply({turn: {id, status: 'inProgress'}});
  const notify = (method, extra) => ws.send(JSON.stringify({method, params: {threadId, turnId: id, ...extra}}));
  const configured = threads.get(threadId).mcp_servers.wanx_task;
  const mcp = spawn(configured.command, configured.args, {env: {PATH: process.env.PATH, ...configured.env}, stdio: ['pipe', 'pipe', 'pipe']});
  const lines = readline.createInterface({input: mcp.stdout})[Symbol.asyncIterator]();
  const calls = [], captured = {input: message.params.input, calls}; let sequence = 0;
  const rpc = async (method, params) => {
    mcp.stdin.write(JSON.stringify({jsonrpc: '2.0', id: ++sequence, method, params}) + '\\n');
    const line = await lines.next(); if (line.done) throw new Error('SYNTHETIC_MCP_CLOSED');
    return JSON.parse(line.value);
  };
  const call = async (name, args = {}) => {
    const response = await rpc('tools/call', {name, arguments: args});
    calls.push({name, arguments: args, response}); return response;
  };
  try {
    await rpc('initialize', {protocolVersion: '2024-11-05'});
    captured.tools = (await rpc('tools/list', {})).result.tools;
    await call('read_material');
    await call('list_sources');
    await call('read_source', {path: 'app/host.mjs'});
    for (const name of ${JSON.stringify(Object.keys(fixed))}) {
      await call('read_source', {path: name});
      await call('write_source', {path: name, content: '// forbidden replacement'});
    }
    const unchanged = await call('validate_app');
    if (unchanged.result?.isError) {
      await call('write_source', {path: 'app/host.html', content: '<main>Report</main><script type="module" src="host.mjs"></script>'});
      await call('write_source', {path: 'app/host.mjs', content: 'import \"./pages/missing.mjs\";'});
      await call('validate_app');
      await call('write_source', {path: 'app/pages/report.mjs', content: 'export const title="PRD report";'});
      await call('write_source', {path: 'app/pages/obsolete.mjs', content: '// temporary'});
      await call('remove_source', {path: 'app/pages/obsolete.mjs'});
      await call('write_source', {path: 'app/host.mjs', content: 'const context = await window.wanx.expertContext();\\n'});
      await call('validate_app');
    }
    await writeFile(${JSON.stringify(capture)}, JSON.stringify(captured));
    notify('turn/completed', {turn: {id, status: 'completed'}});
  } catch (error) {
    captured.failure = error.message;
    await writeFile(${JSON.stringify(capture)}, JSON.stringify(captured));
    notify('turn/completed', {turn: {id, status: 'failed'}});
  } finally {
    mcp.stdin.end(); mcp.kill('SIGTERM');
  }
}));
server.listen(endpoint);
`, {mode: 0o700});

  const proc = spawn(process.execPath, ['codex/driver.mjs'], {
    cwd: root,
    env: {PATH: process.env.PATH, WANX_CODEX_PATH: binary, WANX_CODEX_CONFIG: JSON.stringify({features: {shell_tool: false}, mcp_servers: {}}), WANX_PYTHON_PATH: terminal},
    stdio: ['pipe', 'pipe', 'pipe'], detached: true,
  });
  let errors = '';
  proc.stderr.on('data', chunk => { errors += chunk; });
  t.after(async () => { await stopGroup(proc); await rm(dir, {recursive: true, force: true}); });
  const lines = readline.createInterface({input: proc.stdout})[Symbol.asyncIterator]();
  const events = [];
  proc.stdin.write(JSON.stringify({taskRoot, devKit: true, scope: 'synthetic-standard-expert', files, material, authorizeTools: true}) + '\n');
  for (;;) {
    const {value, done} = await lines.next();
    assert.equal(done, false, errors);
    const event = JSON.parse(value); events.push(event);
    if (event.type === 'authorize') proc.stdin.write(JSON.stringify({id: event.id, result: true}) + '\n');
    if (event.type === 'idle') break;
  }
  assert.equal(errors, '');
  assert.equal(events.some(event => event.type === 'failed'), false, JSON.stringify(events));
  const observed = JSON.parse(await readFile(capture, 'utf8'));
  assert.equal(observed.failure, undefined);
  assert.equal(observed.calls[0].name, 'read_material');
  assert.deepEqual(JSON.parse(observed.calls[0].response.result.content[0].text), material);
  assert.deepEqual(JSON.parse(observed.calls[1].response.result.content[0].text).files, Object.keys(files));
  assert.equal(JSON.parse(observed.calls[2].response.result.content[0].text).content, files['app/host.mjs']);
  for (const call of observed.calls.filter(call => Object.hasOwn(fixed, call.arguments.path))) {
    assert.equal(call.response.result.isError, true, call.arguments.path);
    assert.equal(JSON.parse(call.response.result.content[0].text).code, 'SOURCE_PATH_DENIED');
  }
  for (const [name, content] of Object.entries(fixed)) assert.equal(await readFile(path.join(taskRoot, name), 'utf8'), content);
  const validations = observed.calls.filter(call => call.name === 'validate_app');
  if (modification) {
    assert.equal(validations[0].response.result.isError, true,
      'a standard frozen modification must reject an unchanged submission and keep the tool channel open');
    assert.equal(JSON.parse(validations[0].response.result.content[0].text).code, 'DEVELOPMENT_CHANGE_REQUIRED');
    assert.equal(validations.length, 3, 'the native turn must repair a missing module after the rejected empty submission');
    assert.equal(validations[1].response.result.isError, true);
    assert.match(JSON.parse(validations[1].response.result.content[0].text).code,/^STANDARD_PREVIEW_/);
    assert.equal(validations[2].response.result.isError, false);
    const delivered=events.find(event=>event.type==='result').files;
    assert.equal(delivered['app/pages/report.mjs'],'export const title="PRD report";');
    assert.equal(Object.hasOwn(delivered,'app/pages/obsolete.mjs'),false);
    assert.ok(observed.input.some(part=>part.text?.includes('默认参考模板允许按已确认 PRD 调整')));
    assert.equal(events.find(event => event.type === 'result').files['app/host.mjs'], 'const context = await window.wanx.expertContext();\n');
  } else {
    assert.equal(validations.length, 1);
    assert.equal(validations[0].response.result.isError, false, 'first builds have no frozen modification to enforce');
    assert.deepEqual(events.find(event => event.type === 'result').files, files);
  }
  const developerPrompt = observed.input.filter(part => part.type === 'text').map(part => part.text).join('\n');
  assert.ok(developerPrompt.includes('read_material'), 'the real native turn must name the MCP tool that exposes the frozen ProjectSpec and expert bridge');
  for (const requirement of [material.instruction, ...(modification ? [material.executionPackage.spec.goal,
    ...material.executionPackage.spec.acceptance, material.executionPackage.contract.scope,
    material.requestedChange.text, material.requestedChange.answers[0].answer] : [])]) {
    assert.ok(developerPrompt.includes(requirement),
      'the first native turn must explicitly deliver the current change instruction and frozen execution scope: ' + requirement);
  }
});
}
