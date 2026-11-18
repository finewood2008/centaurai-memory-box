import test from 'node:test';
import assert from 'node:assert/strict';
import {projectApplicationsForUI} from '../shell/ui-broadcast.mjs';
import {registerControlActions} from '../shell/control.mjs';

const applicationId = 'ai.wanx.selfmade.' + 'a'.repeat(32);
const installed = {
  applicationId, name: 'Local deployed fixture', installationSource: 'selfmade',
  deployment: {schemaVersion:1, profile:'wanx-miniapp-v1', slotApplicationId:applicationId, generation:1},
  presentation: {environment:'prod', label:'正式'},
};

test('MemoBox derives managed-local status without restoring environment presentation', () => {
  const [value] = projectApplicationsForUI([installed]);
  assert.equal(value.managedLocal, true);
  assert.equal(Object.hasOwn(value, 'presentation'), false);
  assert.equal(Object.hasOwn(installed, 'managedLocal'), false, 'projection must not mutate the install record');
});

test('a supplied boolean or presentation cannot classify an ordinary or mismatched installation as managed', () => {
  const inputs = [
    {applicationId:'example.local', installationSource:'local', managedLocal:true, presentation:installed.presentation},
    {...installed, deployment:undefined, managedLocal:true},
    {...installed, deployment:{...installed.deployment, slotApplicationId:'example.other'}},
    {...installed, deployment:{...installed.deployment, generation:0}},
  ];
  assert.deepEqual(projectApplicationsForUI(inputs).map(value => value.managedLocal), [false, false, false, false]);
  assert.ok(projectApplicationsForUI(inputs).every(value => !Object.hasOwn(value, 'presentation')));
});

test('both direct application reads use the same main-owned managed-local projection', async () => {
  const handlers = new Map(), frame = {url:'file:///fixture/index.html'}, webContents = {mainFrame:frame};
  registerControlActions({
    ipcMain:{handle:(name, handler) => handlers.set(name, handler)},
    control:{webContents, isDestroyed:() => false}, controlURL:frame.url,
    client:{snapshot:() => ({phase:'disconnected'})},
    applications:{listInstalled:async () => [installed]},
  });
  const event = {sender:webContents, senderFrame:frame};
  for (const name of ['get-state', 'applications-list']) {
    const response = await handlers.get('wanx-client:' + name)(event);
    const [value] = Array.isArray(response) ? response : response.applications;
    assert.equal(value.managedLocal, true, name);
    assert.equal(Object.hasOwn(value, 'presentation'), false, name);
  }
});
