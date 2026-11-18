import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const local = value => { const url = new URL(value); if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password) throw new Error('SMOKE_ENDPOINT_NOT_LOCAL'); return url; };
export async function smokePackagedMemory({ executable, resources, temporary, timeoutMs = 90_000 }) {
  const profile = await mkdtemp(path.join(temporary, 'memobox-runtime-smoke-'));
  const runtimeHome = path.join(profile, 'memory'), descriptor = path.join(profile, 'api.json');
  const source = path.join(resources, 'local-memory'), worker = path.join(resources, 'app.asar', 'shell', 'local-memory-worker.mjs');
  for (const folder of ['AppData', 'LocalAppData', 'tmp']) await mkdir(path.join(profile, folder));
  const child = spawn(executable, [worker, source, runtimeHome, descriptor, path.join(profile, 'api.sqlite')], {
    env: { ...Object.fromEntries(['PATH','Path','SystemRoot','WINDIR','COMSPEC','PATHEXT','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS','ProgramFiles','ProgramFiles(x86)','ProgramData'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
      ELECTRON_RUN_AS_NODE: '1', MEMMY_HOME: runtimeHome, MEMMY_UNIFY_AGENT_SOURCES: '1',
      MEMMY_RUNTIME_CONFIG_PATH: descriptor, MEMMY_CLOUD_URL: 'http://127.0.0.1:1', HOME: profile, USERPROFILE: profile,
      HOMEDRIVE: path.parse(profile).root.replace(/[\\/]+$/, ''), HOMEPATH: profile.slice(path.parse(profile).root.length - 1),
      APPDATA: path.join(profile, 'AppData'), LOCALAPPDATA: path.join(profile, 'LocalAppData'), TMP: path.join(profile, 'tmp'), TEMP: path.join(profile, 'tmp') },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let stderr = '', exited = false;
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12_000); });
  child.stdout.resume();
  const done = new Promise(resolve => { child.once('exit', () => { exited = true; resolve(); }); child.once('error', error => { stderr += error.code || error.message; exited = true; resolve(); }); });
  let api;
  try {
    const deadline = Date.now() + timeoutMs;
    while (!exited && Date.now() < deadline) {
      try {
        const candidate = JSON.parse(await readFile(descriptor, 'utf8'));
        local(candidate.baseUrl);
        if (typeof candidate.localToken !== 'string' || candidate.localToken.length < 16) throw new Error('SMOKE_TOKEN_INVALID');
        const response = await fetch(new URL('/api/app/bootstrap', candidate.baseUrl), { headers: { 'x-memmy-local-token': candidate.localToken }, signal: AbortSignal.timeout(2000) });
        if (response.ok) { api = candidate; break; }
      } catch { /* Wait for the dedicated worker to create its descriptor. */ }
      await delay(150);
    }
    if (!api) throw new Error('PACKAGED_MEMORY_STARTUP_FAILED:' + stderr.replace(/[a-f0-9]{32,}/gi, '[redacted]').slice(-4000));
    const authenticated = async route => {
      const response = await fetch(new URL(route, api.baseUrl), { headers: { 'x-memmy-local-token': api.localToken }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error('PACKAGED_MEMORY_HTTP_FAILED:' + route + ':' + response.status);
      return response.json();
    };
    const health = await authenticated('/api/v1/health');
    if (health.ok !== true || health.storage?.ready !== true) throw new Error('PACKAGED_MEMORY_STORAGE_NOT_READY');
    await authenticated('/api/agent-sources');
    const denied = await fetch(new URL('/api/app/bootstrap', api.baseUrl), { signal: AbortSignal.timeout(2000) });
    if (![401,403].includes(denied.status)) throw new Error('PACKAGED_MEMORY_AUTH_NOT_ENFORCED');
    return { ok: true, platform: process.platform, arch: process.arch, bootstrap: true, memoryStorageReady: true, agentSources: true, unauthorizedRequestRejected: true, syntheticProfile: true };
  } finally {
    // The memory engine is detached from the worker. Shut down only this
    // synthetic engine through its authenticated endpoint before ending worker.
    try {
      const configFile = path.join(runtimeHome, 'config.yaml');
      const yaml = createRequire(path.join(source, 'Memory', 'package.json'))('yaml');
      const storage = yaml.parse(await readFile(configFile, 'utf8'))?.memmyMemory?.storage;
      const record = JSON.parse(await readFile(path.join(runtimeHome, 'memory-service', 'runtime.json'), 'utf8'));
      if (record.configPath === configFile && storage?.token) {
        await fetch(new URL('/api/v1/admin/shutdown', local(record.endpoint)), { method: 'POST', headers: { authorization: `Bearer ${storage.token}` }, signal: AbortSignal.timeout(3000) });
      }
    } catch { /* A failed startup may have no engine/config yet. */ }
    if (!exited) child.kill();
    await Promise.race([done, delay(4000)]);
    for (let attempt = 0; attempt < 20; attempt++) {
      try { await rm(profile, { recursive: true, force: true }); break; }
      catch (error) { if (attempt === 19) throw error; await delay(500); }
    }
  }
}
