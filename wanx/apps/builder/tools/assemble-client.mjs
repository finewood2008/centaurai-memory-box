// Rebuild Builder resources from checked-in source. Generated assets stay ignored.
import { build } from 'esbuild';
import { assembleStarlink } from './assemble-starlink.mjs';
import {buildKnowledgeTemplate} from './build-knowledge-template.mjs';
import {buildZhikeTemplate} from './build-zhike-template.mjs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const edition = process.argv[2];
if (!['personal', 'team'].includes(edition)) throw Error('EDITION_REQUIRED');
const client = path.resolve(root, edition==='personal'?'../personal-client':'../team-client');
await assembleStarlink(edition);
const personalDialogueFiles = new Set([
  'local-ui/renderer/ai-dialogue.js',
  'local-ui/renderer/ai-dialogue.css',
  'shell/ai-dialogue.mjs',
]);
for (const [folder, names] of [
  ['local-ui/renderer', ['ai-dialogue.js','ai-dialogue.css','space-shares.js','space-shares.css','space-workspaces.js','space-agent-hub.js','space-agent-hub.css','space-document-preview.css']],
  ['shell', ['space-shares.mjs','ai-dialogue.mjs','assistant-service.mjs','assistant-channels.mjs','channel-qr.mjs','channel-qr.LICENSE']],
  ['local-ui/panel', ['panel-assistant.js','panel-assistant.css']],
]) for (const name of names) {
  // Mini owns its dialogue renderer and local device identity wrapper.
  if (edition === 'personal' && personalDialogueFiles.has(`${folder}/${name}`)) continue;
  await mkdir(path.join(client,folder),{recursive:true});
  await cp(path.join(root,'integration/team-client',name),path.join(client,folder,name));
}
await cp(path.join(root,'integration/team-client/channel-icons'),path.join(client,'local-ui/renderer/channel-icons'),{recursive:true});
// Both editions use the same file preview/transfer implementation.
if (edition === 'team') for (const file of ['shell/personal-space.mjs','shell/space-drive-routing.mjs','local-ui/renderer/personal-space.js']) {
  let source = await readFile(path.join(root,'../personal-client',file),'utf8');
  if (file === 'shell/personal-space.mjs') source = source.replace('"../device-trust/data-context.mjs"','"./cloud-context.mjs"').replace('changed || client.snapshot().dataIdentity?.profileId','changed');
  await writeFile(path.join(client,file),source);
}
// Mini reuses only the iterative workspace; new-product creation stays in Studio.
if (edition === 'personal') {
  await buildKnowledgeTemplate();
  await buildZhikeTemplate();
  for (const script of ['build','package']) execFileSync(process.platform==='win32'?'npm.cmd':'npm',['run',script],{cwd:root,stdio:'inherit',shell:process.platform==='win32'});
  const personalVersion=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version;
  await mkdir(path.join(client,'workshop'),{recursive:true});
  await cp(path.join(root,'release/wanx-studio-'+personalVersion),path.join(client,'workshop/workbench'),{recursive:true});
  await cp(path.join(root,'dist/runtime'),path.join(client,'workshop/runtime'),{recursive:true});
  await cp(path.join(root,'integration/embedded-preload.cjs'),path.join(client,'workshop/embedded-preload.cjs'));
  await build({entryPoints:[path.join(root,'integration/personal-client/workshop-service.mjs')],bundle:true,platform:'node',format:'esm',external:['electron'],banner:{js:'import {createRequire as workshopRequire} from "node:module";const require=workshopRequire(import.meta.url);'},outfile:path.join(client,'shell/personal-workshop.mjs'),logLevel:'silent'});
  await mkdir(path.join(client,'local-ui/renderer/assets/app-icons'),{recursive:true});
  await cp(path.join(root,'ui/assets/wanx-workshop-v1.png'),path.join(client,'local-ui/renderer/assets/app-icons/workshop-v1.png'));
  for(const name of ['workshop.js','workshop.css','personal-layout.css','material-theme.css','action-menus.js'])await cp(path.join(root,'integration/personal-client',name),path.join(client,'local-ui/renderer',name));
  await cp(path.join(root,'integration/personal-client/assets/material-v1'),path.join(client,'local-ui/renderer/assets/material-v1'),{recursive:true});
  await cp(path.join(root,'integration/personal-client/assets/section-icons-v2'),path.join(client,'local-ui/renderer/assets/section-icons-v2'),{recursive:true});
  for(const name of ['studio-product.js','studio-home.css','construction.css'])await cp(path.join(root,'integration',name),path.join(client,'local-ui/renderer',name));
  await build({entryPoints:[path.join(root,'integration/personal-client/data-service.mjs')],bundle:true,platform:'node',format:'esm',outfile:path.join(client,'shell/personal-data-service.mjs'),banner:{js:'import {createRequire as personalDataRequire} from "node:module";const require=personalDataRequire(import.meta.url);'},logLevel:'silent'});
  await build({entryPoints:[path.join(root,'integration/team-client/data-view.js')],bundle:true,platform:'browser',format:'iife',outfile:path.join(client,'local-ui/renderer/data-view.js'),logLevel:'silent'});
  await cp(path.join(root,'integration/team-client/data.css'),path.join(client,'local-ui/renderer/data.css'));
  process.exit(0);
}
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
for (const script of ['build', 'package']) {
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', script], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
}
await mkdir(path.join(client, 'studio'), { recursive: true });
await cp(path.join(root, 'dist/runtime'), path.join(client, 'applications/studio-runtime'), { recursive: true });
await cp(path.join(root, `release/wanx-studio-${version}`), path.join(client, 'studio/workbench'), { recursive: true });
// The packaged host must resolve everything inside its own ASAR, with no repo paths.
await build({ entryPoints: [path.join(root, 'integration/host-control.mjs')], bundle: true, platform: 'node', format: 'esm', banner:{js:'import {createRequire as workshopRequire} from "node:module";const require=workshopRequire(import.meta.url);'}, outfile: path.join(client, 'applications/studio.mjs'), logLevel: 'silent' });
await build({ entryPoints: [path.join(root, 'integration/embedded-workspace.mjs')], bundle: true, platform: 'node', format: 'esm', banner:{js:'import {createRequire as workshopRequire} from "node:module";const require=workshopRequire(import.meta.url);'}, outfile: path.join(client, 'studio/embedded-workspace.mjs'), logLevel: 'silent' });
await cp(path.join(root, 'integration/embedded-preload.cjs'), path.join(client, 'studio/embedded-preload.cjs'));
for(const name of ['studio-home.js','studio-product.js','studio-intake.js','studio-input.js','studio-home.css','construction.js','construction.css'])await cp(path.join(root,'integration',name),path.join(client,'local-ui/renderer',name));
await mkdir(path.join(client,'local-ui/renderer/assets'),{recursive:true});
await cp(path.join(root,'ui/assets/wanx-builder.svg'),path.join(client,'local-ui/renderer/assets/wanx-builder.svg'));
if(edition==='team'){
 await cp(path.join(root,'integration/team-client/data.css'),path.join(client,'local-ui/renderer/data.css'));
 await cp(path.join(root,'integration/team-client/view.js'),path.join(client,'local-ui/renderer/team-view.js'));
 await cp(path.join(root,'integration/team-client/feature-access.js'),path.join(client,'local-ui/renderer/team-feature-access.js'));
}
if(edition==='team')
for (const [source, output, platform] of [
  ['service.mjs', 'shell/team-service.mjs', 'node'],
  ['data-service.mjs', 'shell/team-data-service.mjs', 'node'],
  ['wanx-mcp-bridge.mjs', 'shell/wanx-mcp-bridge.mjs', 'node'],
  ['data-view.js', 'local-ui/renderer/data-view.js', 'browser'],
]) {
  await build({ entryPoints: [path.join(root, 'integration/team-client', source)], bundle: true, platform, format: platform === 'browser' ? 'iife' : 'esm', outfile: path.join(client, output), logLevel: 'silent',
    ...(source === 'data-service.mjs' ? { banner: { js: 'import {createRequire as teamDataRequire} from "node:module";const require=teamDataRequire(import.meta.url);' } } : {}) });
}
