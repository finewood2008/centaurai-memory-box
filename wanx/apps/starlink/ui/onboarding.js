import { OnboardingDialogue, dialogueError } from './onboarding-dialogue-state.mjs';
import { OnboardingHome } from './onboarding-home-state.mjs';
import { readWorkbenchReply } from './native-workbench.js';
import { quickCreateWarehouse, readQuickCreation } from './onboarding-quick.mjs';
import { installInitialOntology } from './warehouse-initial-ontology.mjs';
import { DEFAULT_WAREHOUSE_ONTOLOGY_PROFILE, WAREHOUSE_ONTOLOGY_PROFILES } from '../shared/warehouse-ontology-profiles.mjs';

const fail = code => Object.assign(new Error(code), { code });
const profileById = new Map(WAREHOUSE_ONTOLOGY_PROFILES.map(profile => [profile.id, profile]));
const legacyCreateActions = new Set(['onboarding-save', 'onboarding-create']);

export function createOnboardingUI({ bridge, call, enter, onChange, onCreated }) {
  const dialog = document.querySelector('#warehouse-creation');
  const form = dialog.querySelector('form');
  const name = dialog.querySelector('#warehouse-creation-name');
  const change = dialog.querySelector('#warehouse-profile-change');
  const options = dialog.querySelector('#warehouse-profile-options');
  const current = dialog.querySelector('#warehouse-creation-profile');
  const profileSummary = current.closest('.warehouse-profile-summary');
  const note = dialog.querySelector('#warehouse-creation-note');
  const error = dialog.querySelector('#warehouse-creation-error');
  const submit = dialog.querySelector('#warehouse-creation-submit');
  const useExisting = dialog.querySelector('#warehouse-creation-use-existing');
  const closeButtons = [...dialog.querySelectorAll('[data-creation-close]')];
  const storage = window.localStorage;
  const legacyQuick = completed => bridge?.legacyQuickCreation?.(completed);
  let active = null;

  for (const profile of WAREHOUSE_ONTOLOGY_PROFILES) {
    const label = document.createElement('label');
    label.className = 'warehouse-profile-option';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'warehouse-ontology-profile';
    radio.value = profile.id;
    const words = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = profile.label;
    const detail = document.createElement('small');
    detail.textContent = profile.description;
    words.append(title, detail);
    label.append(radio, words);
    options.append(label);
  }

  function records(identity, request) {
    const quick = readQuickCreation(storage, identity, legacyQuick);
    if (quick) return { quick, pending: true, warehouse: quick.warehouse };
    const guided = new OnboardingDialogue({ storage, identity, call: request });
    const legacy = new OnboardingHome({ storage, identity, call: request });
    guided.restore();
    legacy.restore();
    if (guided.saved.creation || legacyCreateActions.has(guided.saved.pending?.action) || guided.saved.entryPending) {
      return { guided, pending: true, warehouse: guided.saved.warehouse, entryPending: guided.saved.entryPending };
    }
    if (legacy.state.creation) return { legacy, pending: true };
    return { pending: false };
  }

  function status(identity) {
    if (identity?.dataScope !== 'personal') return { pending: false };
    try {
      const recovery = records(identity);
      return { pending: recovery.pending, entryPending: recovery.entryPending, quickCreated: !!recovery.quick?.warehouse };
    } catch {
      return { pending: true };
    }
  }

  function render() {
    if (!active) return;
    const { busy, recovery } = active;
    const pending = !!recovery?.pending;
    profileSummary.hidden = pending && !recovery?.quick?.ontology;
    current.textContent = profileById.get(active.profileId).label;
    name.readOnly = pending || busy;
    change.disabled = pending || busy;
    options.disabled = pending || busy;
    change.setAttribute('aria-expanded', String(!options.hidden));
    for (const radio of options.querySelectorAll('input')) radio.checked = radio.value === active.profileId;
    for (const button of closeButtons) button.disabled = busy;
    submit.disabled = busy || !!active.readError || (!pending && !name.value.trim());
    useExisting.hidden = !active.conflict;
    useExisting.disabled = busy;
    submit.textContent = busy ? '正在准备星图…' : pending ? '继续创建' : '创建星图';
    note.textContent = busy ? '正在创建星图并启用所选本体。' : pending
      ? '可以继续上次请求，已创建的星图会直接打开。' : '';
    note.hidden = !note.textContent;
    error.textContent = active.error || '';
    error.hidden = !error.textContent;
  }

  function close() {
    active = null;
    dialog.close();
    onChange?.();
  }
  function open(identity) {
    if (identity?.dataScope !== 'personal' || active) return;
    const entry = active = { identity, busy: false, profileId: DEFAULT_WAREHOUSE_ONTOLOGY_PROFILE };
    try {
      entry.recovery = records(identity);
    } catch {
      entry.readError = true;
      entry.error = '暂时无法读取上次创建记录，请重新连接后再试。';
    }
    name.value = entry.recovery?.quick?.input.name || entry.recovery?.guided?.saved.name ||
      entry.recovery?.legacy?.state.creation?.answers?.warehouse_name || '';
    entry.profileId = entry.recovery?.quick?.ontology?.id ?? DEFAULT_WAREHOUSE_ONTOLOGY_PROFILE;
    options.hidden = true;
    render();
    dialog.showModal();
    (name.readOnly ? submit : name).focus();
    onChange?.();
  }

  change.addEventListener('click', () => {
    options.hidden = !options.hidden;
    render();
    if (!options.hidden) options.querySelector(':checked')?.focus();
  });
  options.addEventListener('change', event => {
    if (!active || options.disabled || !profileById.has(event.target.value)) return;
    active.profileId = event.target.value;
    render();
  });
  name.addEventListener('input', () => {
    if (active && !active.readError) active.error = '';
    render();
  });
  for (const control of closeButtons) control.addEventListener('click', () => { if (!active?.busy) close(); });
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    if (!active?.busy) close();
  });
  dialog.addEventListener('close', () => {
    if (active && !active.busy && !dialog.open) close();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const entry = active;
    if (!entry || entry.busy || submit.disabled) return;
    const keepCurrentRules = event.submitter === useExisting && !!entry.conflict;
    const isCurrent = () => active === entry;
    const guard = () => { if (!isCurrent()) throw fail('HOST_SESSION_EXPIRED'); };
    const request = async (action, input = {}, warehouseId = input.warehouseId ?? null) => {
      guard();
      const result = await call(action, input, warehouseId);
      guard();
      return action.startsWith('onboarding-') || action === 'workbench-request' ? readWorkbenchReply(result) : result;
    };
    const enterCurrent = async warehouse => {
      guard();
      await enter(warehouse, { isCurrent });
      guard();
    };
    entry.busy = true;
    entry.error = '';
    options.hidden = true;
    render();
    onChange?.();
    try {
      const recovery = records(entry.identity, request);
      if (recovery.guided) {
        const warehouse = recovery.entryPending ? recovery.warehouse : await recovery.guided.recoverWarehouseCreation();
        await enterCurrent(warehouse);
        if (recovery.entryPending) {
          recovery.guided.saved.entryPending = false;
          recovery.guided.persist();
        }
      } else if (recovery.legacy) {
        await recovery.legacy.load();
        if (!recovery.legacy.state.error) await recovery.legacy.create();
        if (!recovery.legacy.state.warehouse || recovery.legacy.state.error)
          throw fail(recovery.legacy.state.errorCode || 'WAREHOUSE_UNAVAILABLE');
        await enterCurrent(recovery.legacy.state.warehouse);
      } else {
        await quickCreateWarehouse({
          storage, identity: entry.identity, call: request, enter: enterCurrent, legacyQuick, isCurrent,
          name: name.value.trim(), description: profileById.get(entry.profileId).goal, profileId: entry.profileId,
          installOntology: (record, save) => keepCurrentRules && record.input.operationId === entry.conflict
            ? undefined : installInitialOntology({
            record, save,
            readWarehouse: () => request('warehouse', { id: record.warehouse.id }, record.warehouse.id),
            request: (url, method = 'GET', body, operationId) => request('workbench-request',
              { url, method, ...(body && { body: JSON.stringify(body) }), ...(operationId && { operationId }) }, record.warehouse.id),
          }),
        });
      }
      close();
      onCreated?.();
    } catch (reason) {
      if (!isCurrent()) return;
      entry.busy = false;
      try { entry.recovery = records(entry.identity); } catch { entry.readError = true; }
      entry.conflict = reason.code === 'WAREHOUSE_INITIAL_ONTOLOGY_CHANGED' && entry.recovery?.quick?.warehouse
        ? entry.recovery.quick.input.operationId : null;
      entry.error = entry.conflict
        ? '已创建的星图有新的规则或资料。可以保留当前规则并打开星图。'
        : reason.code === 'WAREHOUSE_NAME_CONFLICT' ? '已有同名星图，请修改名称。'
        : entry.recovery?.quick?.warehouse ? '星图已创建，设置初始本体或打开资料库的结果待确认。可以继续原请求。'
        : dialogueError(reason);
      if (!dialog.open) dialog.showModal();
      render();
      onChange?.();
    }
  });
  return { open, status, close, reset: close, get visible() { return !!active; }, get busy() { return !!active?.busy; } };
}
