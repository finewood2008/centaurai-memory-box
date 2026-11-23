import {execFileSync} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {npmCommand} from '../../../tools/npm-command.mjs';
import {readSourceClientManifest} from './client-package-manifest.mjs';
import {assertPackagedMemoryTarget, preparePackagedMemory, verifyPackagedMemory} from './package-client-memory.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

async function packagePreview(platform, arch) {
  assertPackagedMemoryTarget({platform, arch});
  const {pkg} = await readSourceClientManifest(root);
  const windows = platform === 'win32';
  const run = (command, args) => execFileSync(command, args, {cwd:root, stdio:'inherit'});
  for (const task of ['build:studio', 'build:renderer', 'build:maintenance']) {
    run(...npmCommand(['run', task]));
  }
  const memory = await preparePackagedMemory({clientRoot:root, platform, arch});
  run(process.execPath, ['tools/build-network.mjs', `${platform}-${arch}`]);
  run(process.execPath, ['tools/build-discovery.mjs', windows ? 'win32-x64' : `darwin-${arch}`]);
  if (!windows) run(process.execPath, ['tools/build-clipboard.mjs', arch]);

  const {build, Platform, Arch} = await import('electron-builder');
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'wanx-client-preview-'));
  const configFile = path.join(configDir, 'builder.json');
  try {
    await writeFile(configFile, JSON.stringify({
      ...pkg.build,
      extraResources: [...pkg.build.extraResources, ...memory.extraResources,
        ...(windows ? [{from:'shell/windows-private-acl.ps1', to:'security/windows-private-acl.ps1'}] : [])],
    }));
    const targets = (windows ? Platform.WINDOWS : Platform.MAC)
      .createTarget([windows ? 'nsis' : 'dir'], arch === 'arm64' ? Arch.arm64 : Arch.x64);
    await build({projectDir:root, targets, config:configFile, publish:'never'});
  } finally {
    await rm(configDir, {recursive:true, force:true});
  }
  const output = path.join(root, pkg.build.directories.output);
  const suffix = arch === 'arm64' ? '-arm64' : '';
  const product = pkg.build.productName;
  const bundle = path.join(output, windows ? `win${suffix}-unpacked` : `mac${suffix}/${product}.app`);
  await verifyPackagedMemory({
    resourcesPath: path.join(bundle, windows ? 'resources' : 'Contents/Resources'),
    executable: path.join(bundle, windows ? `${pkg.build.win.executableName ?? product}.exe` : `Contents/MacOS/${product}`),
    platform, arch,
  });
}

try {
  const {positionals:[platform, ...rest], values} = parseArgs({
    allowPositionals:true, options:{arm64:{type:'boolean'}, x64:{type:'boolean'}},
  });
  if (!platform || rest.length || (values.arm64 && values.x64)) throw new Error('CLIENT_PACKAGE_TARGET_REQUIRED');
  const arch = values.arm64 ? 'arm64' : values.x64 ? 'x64' : process.arch;
  await packagePreview(platform, arch);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
