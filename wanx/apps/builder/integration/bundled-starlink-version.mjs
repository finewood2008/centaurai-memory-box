import { readFile } from 'node:fs/promises';
import path from 'node:path';
import semver from 'semver';

// Use the host's existing versioned installer. Never downgrade a newer install,
// override a rollback/selection, or close a running editor to replace its code.
export async function needsBundledStarlink(installed, packageDir, applications) {
  if (!installed) return true;
  if (!packageDir || installed.selectionRequired || installed.envelope || installed.artifactId || !semver.valid(installed.version)) return false;
  if (semver.valid(installed.previous?.version) && semver.gt(installed.previous.version,installed.version)) return false;
  const manifest=JSON.parse(await readFile(path.join(packageDir,'application.manifest.json'),'utf8'));
  if (!semver.valid(manifest.version)) throw Object.assign(Error('TEAM_STARLINK_PACKAGE_INVALID'),{code:'TEAM_STARLINK_PACKAGE_INVALID'});
  if (!semver.gt(manifest.version,installed.version)) return false;
  return !applications.activate?.('centaurai.wanx.semantica');
}
