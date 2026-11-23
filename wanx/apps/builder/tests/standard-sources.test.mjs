import assert from 'node:assert/strict';
import test from 'node:test';
import {sourcePath, validateSources} from '../core/artifact.mjs';
import {patchSource} from '../core/source-patch.mjs';

test('standard developer edits nested renderer sources while denying legacy and platform paths', () => {
  const files={'app/host.html':'<main>Report</main>','app/pages/report.mjs':'export const title="Report";', 'app/theme.css':'main {display:grid}'};
  assert.equal(validateSources(files,true),files);
  assert.match(patchSource(files,{path:'app/pages/report.mjs',find:'Report',replace:'Analysis'},true),/Analysis/);
  for(const name of ['miniapp.manifest.json','src/app.js','shell/main.cjs','app/../main.js','app//x.js','app/.env','app/CON.json','app/x%2fy.js','app/x\\y.js']) assert.throws(()=>sourcePath(name,true),/SOURCE_PATH_DENIED/);
  assert.throws(()=>validateSources({'app/A.js':'','app/a.js':''},true),/SOURCE_PATH_DENIED/);
});
