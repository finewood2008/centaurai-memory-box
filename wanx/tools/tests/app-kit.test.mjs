import test from 'node:test';
import assert from 'node:assert/strict';
import {access, mkdtemp, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buildAppKit} from '../build-app-kit.mjs';

test('buildAppKit creates a versioned workspace Kit with source and SDK digest', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'wanx-app-kit-'));
  try {
    await assert.rejects(buildAppKit({version: '0.3.0+api-reference.8', out: temp}), /KIT_SDK_VERSION_MISMATCH/);
    await assert.rejects(buildAppKit({version: '0.3.0-workspace', out: temp}), /KIT_SDK_VERSION_MISMATCH/);
    const {output, manifest} = await buildAppKit({version: '0.3.0', out: temp});
    assert.equal(manifest.kitId, 'wanx-app-kit');
    assert.equal(path.basename(output), '0.3.0');
    assert.equal(manifest.kitVersion, '0.3.0');
    assert.equal(manifest.distribution, 'workspace');
    assert.equal(manifest.artifacts[0].version, '0.3.0');
    assert.equal(manifest.artifacts[1].version, '0.3.0');
    assert.match(manifest.source.revision, /^[0-9a-f]{40}$/);
    assert.equal(manifest.artifacts[0].name, '@centaurai/wanx-host-sdk');
    assert.equal(manifest.artifacts[0].version, '0.3.0');
    assert.equal(manifest.artifacts[0].packageFile, 'centaurai-wanx-host-sdk-0.3.0.tgz');
    assert.match(manifest.artifacts[0].sha256, /^[0-9a-f]{64}$/);
    assert.equal(manifest.artifacts[0].files.some(file => file.startsWith('contracts/')), false);
    assert.equal(manifest.artifacts[1].kind, 'contract');
    assert.equal(manifest.artifacts[1].name, 'wanx-app-contracts');
    assert.equal(manifest.artifacts[1].version, '0.3.0');
    assert.match(manifest.artifacts[1].sha256, /^[0-9a-f]{64}$/);
    await access(path.join(output, manifest.artifacts[0].packageFile));
    assert.equal(manifest.artifacts[1].files.includes('api.openapi.json'), false);
    const modulesDir = path.join(output, 'contracts/octop-modules');
    const {modules} = JSON.parse(await readFile(path.join(modulesDir, 'index.json'), 'utf8'));
    const specs = new Map();
    for (const module of modules) {
      const spec = JSON.parse(await readFile(path.join(modulesDir, module.file), 'utf8'));
      assert.equal(spec.openapi, '3.1.0');
      specs.set(module.name, spec);
    }
    await access(path.join(output, 'contracts/api-catalog.v1.json'));
    await access(path.join(output, 'contracts/permissions.v1.json'));
    await access(path.join(output, 'contracts/errors.v1.json'));
    await access(path.join(output, 'contracts/types.d.ts'));
    await access(path.join(output, 'contracts/schemas/model-list.v1.schema.json'));
    for (const schema of [
      'agent-list.v1.schema.json', 'thread-history.v1.schema.json',
      'chat-ws.v1.schema.json', 'expert-detail.v1.schema.json',
      'dialogue-session.v1.schema.json', 'dialogue-event.v1.schema.json',
      'memory-page.v1.schema.json', 'memory-mutation.v1.schema.json'
    ]) await access(path.join(output, 'contracts/schemas', schema));
    const errors = JSON.parse(await readFile(path.join(output, 'contracts/errors.v1.json'), 'utf8'));
    const catalog = JSON.parse(await readFile(path.join(output, 'contracts/api-catalog.v1.json'), 'utf8'));
    const status = JSON.parse(await readFile(path.join(output, 'contracts/contract-status.v1.json'), 'utf8'));
    const driveApi = specs.get('personal-space');
    const starlinkApi = specs.get('starlink');
    assert.ok(driveApi.paths['/api/personal-space/uploads/{upload_id}/complete'].post['x-wanx-application-contract']);
    assert.ok(specs.get('dialogue').paths['/api/dialogue/sessions'].post['x-wanx-application-contract']);
    assert.ok(specs.get('memory').paths['/api/agents/{agent_id}/memory/atoms'].post['x-wanx-application-contract']);
    assert.equal(driveApi['x-wanx-permissions'], '../permissions.v1.json');
    assert.ok(!specs.has('semantica'));
    assert.ok(errors.errors.some(error => error.code === 'SPACE_INVALID_SIZE'));
    assert.equal(status.apis.find(apiItem => apiItem.id === 'agent.thread').status, 'ready-for-acceptance');
    assert.equal(status.apis.find(apiItem => apiItem.id === 'dialogue.session').status, 'ready-for-acceptance');
    assert.equal(status.apis.find(apiItem => apiItem.id === 'memory').status, 'ready-for-acceptance');
    assert.equal(catalog.surfaces.find(surface => surface.id === 'agent.thread').status, 'ready-for-acceptance');
    assert.equal(catalog.surfaces.find(surface => surface.id === 'dialogue.session').status, 'ready-for-acceptance');
    assert.equal(catalog.surfaces.find(surface => surface.id === 'memory').status, 'ready-for-acceptance');
    const starlink = catalog.surfaces.find(surface => surface.id === 'star-map');
    assert.equal(starlink.status, 'open');
    assert.equal(status.apis.find(item => item.id === 'starlink.evidence').status, starlink.status);
    for (const [method, route] of [
      ['get', 'warehouse'], ['get', 'documents'], ['get', 'graph'], ['post', 'search'],
      ['get', 'evidence/{id}'], ['post', 'reasoning/{operation}'],
    ]) {
      const endpoint = `/api/semantica/open/v1/${route}`;
      assert.ok(starlink.routes.some(item => item.path === endpoint && item.method === method.toUpperCase()));
      assert.deepEqual(starlinkApi.paths[endpoint][method].security, [{hostSession: [], starlinkWarehouseKey: []}]);
    }
    assert.equal(starlinkApi.components.securitySchemes.starlinkWarehouseKey.name, 'X-Xingtu-Key');
    const reasoning = starlinkApi.paths['/api/semantica/open/v1/reasoning/{operation}'].post;
    assert.deepEqual(reasoning.parameters[0].schema.enum, [
      'discover', 'prepare', 'reference', 'scope', 'search', 'evidence', 'read-document', 'coverage',
    ]);
    const drive = catalog.surfaces.find(surface => surface.id === 'space.drive');
    assert.equal(drive.status, status.apis.find(item => item.id === drive.id).status);
    assert.ok(drive.routes.some(route => route.path === '/api/personal-space/app-folders' && route.method === 'POST'));
    assert.ok(driveApi.paths['/api/personal-space/app-folders'].post['x-wanx-application-contract']);
    for (const file of ['octop-api.md', 'drive-api.md', 'starlink-api.md']) {
      await access(path.join(output, 'contracts', file));
    }
    const models = catalog.readOnlyCatalog.find(item => item.id === 'models');
    assert.equal(models.status, 'ready-for-acceptance');
    assert.deepEqual(models.routes.map(route => route.path), ['/api/dialogue/models']);
    const privatePath = /^\/api\/(?:users|auth|providers|admin)(?:\/|$)/;
    const permissions = JSON.parse(await readFile(path.join(output, 'contracts/permissions.v1.json'), 'utf8'));
    const applicationPaths = [
      ...[...specs.values()].flatMap(spec => Object.entries(spec.paths)
        .filter(([, item]) => Object.values(item).some(operation =>
          operation['x-wanx-application-contract'] || operation['x-wanx-permission']))
        .map(([route]) => route)),
      ...[...catalog.surfaces, ...catalog.readOnlyCatalog].flatMap(surface => (surface.routes ?? []).map(route => route.path)),
      ...permissions.capabilities.flatMap(capability => capability.routes),
    ];
    assert.deepEqual(applicationPaths.filter(route => privatePath.test(route)), []);
    assert.equal(manifest.artifacts[1].files.some(file => path.basename(file) === 'octop.openapi.json'), false);
    assert.equal(manifest.artifacts[1].files.includes('octop-api-inventory.md'), false);
    assert.deepEqual(
      modules.map(module => `octop-modules/${module.file}`).sort(),
      manifest.artifacts[1].files.filter(file => file.startsWith('octop-modules/') && file.endsWith('.openapi.json')).sort(),
    );
    for (const [name, route] of [
      ['users', '/api/users'],
      ['providers', '/api/providers/resolved'],
      ['admin', '/api/admin/providers'],
      ['channels', '/api/agents/{agent_id}/channels'],
    ]) assert.ok(specs.get(name)?.paths[route]?.get, route);
    assert.ok(specs.get('websocket')['x-wanx-supplemental-routes'].some(
      route => route.method === 'WS' && route.path === '/api/agents/{agent_id}/chat/ws',
    ));
    assert.ok(starlinkApi['x-wanx-supplemental-routes'].some(
      route => route.method === 'POST' && route.path === '/mcp/starlink',
    ));
    const packageJson = JSON.parse(await readFile(path.join(output, 'sdk/@centaurai/wanx-host-sdk/package.json'), 'utf8'));
    assert.equal(packageJson.name, '@centaurai/wanx-host-sdk');
  } finally {
    await rm(temp, {recursive: true, force: true});
  }
});
