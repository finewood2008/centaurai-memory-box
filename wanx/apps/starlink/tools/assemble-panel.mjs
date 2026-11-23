import { cp, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import { npmCommand } from '../../../tools/npm-command.mjs';
import {syncStarxiaotuCatalog} from './sync-starxiaotu-catalog.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
export async function assembleStarlinkPanel(client, { buildFrontend = true } = {}) {
  await syncStarxiaotuCatalog({check:true});
  if (buildFrontend) execFileSync(...npmCommand(['run', 'build']), {
    cwd: path.join(root, 'frontend'), stdio: 'inherit',
  });
  const target = path.join(client, 'local-ui/starlink');
  await mkdir(target, { recursive: true });
  await cp(path.join(root, 'ui'), path.join(target, 'ui'), { recursive: true });
  await cp(path.join(root, 'resources'), path.join(target, 'resources'), { recursive: true });
  await cp(path.join(root, 'frontend/dist'), path.join(target, 'ui/workbench'), { recursive: true });
  await cp(path.join(root, 'shared'), path.join(target, 'shared'), { recursive: true });
  await cp(path.join(root, 'integration/panel-view.js'), path.join(client, 'local-ui/renderer/data-view.js'));
  await cp(path.join(root, 'integration/panel.css'), path.join(client, 'local-ui/renderer/data.css'));
  const require = createRequire(new URL('../../builder/package.json', import.meta.url));
  const { build } = require('esbuild');
  await build({ entryPoints: [path.join(root, 'integration/client-service.mjs')], bundle: true,
    platform: 'node', format: 'esm', outfile: path.join(client, 'shell/starlink-panel-service.mjs'),
    banner: { js: 'import {createRequire as starlinkRequire} from "node:module";const require=starlinkRequire(import.meta.url);' }, logLevel: 'silent' });
}
