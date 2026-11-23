import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const page = (await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const drawer = await readFile(new URL('../src/components/OntologyEditor.tsx', import.meta.url), 'utf8');
for (const inline of [false, true]) test(`unapplied type edits protect warehouse navigation in the ${inline ? 'page' : 'drawer'}`, () => {
  const notifications = [], unmount = [];
  const start = drawer.indexOf('  useEffect(() => {', drawer.indexOf('  const dirty ='));
  const end = drawer.indexOf('  function close()', start);
  const context = vm.createContext({ dirty: true, inline, onDirtyChange: value => notifications.push(value),
    errors: [], errorSummary: { current: null }, draft: {}, setErrors() {},
    dialog: { current: { showModal() {}, close() {} } },
    document: { activeElement: null, body: { style: {} } }, window: { addEventListener() {}, removeEventListener() {} },
    useEffect: effect => { const cleanup = effect(); if (cleanup) unmount.push(cleanup); },
  });
  vm.runInContext(stripTypeScriptTypes(drawer.slice(start, end)), context);
  assert.equal(notifications.at(-1), true, 'the containing page must know about local drawer edits');
  for (const cleanup of unmount.reverse()) cleanup();
  assert.equal(notifications.at(-1), false);

  const effect = page.indexOf('  useEffect(() => {\n    onLeaveStateChange(', page.indexOf('function OntologyView('));
  const finish = page.indexOf('\n  useEffect(', effect + 1);
  let reported;
  vm.runInNewContext(stripTypeScriptTypes(page.slice(effect, finish)), {
    dirty: false, assistantDirty: false, drawerDirty: true, busy: false,
    onLeaveStateChange: value => { reported = value; }, useEffect: fn => fn(), window: { addEventListener() {}, removeEventListener() {} },
  });
  assert.equal(reported.dirty, true, 'unapplied drawer changes must reach the existing leave guard');
});
