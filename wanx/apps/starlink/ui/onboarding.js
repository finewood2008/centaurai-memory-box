import { OnboardingDialogue } from './onboarding-dialogue-state.mjs';
import { OnboardingHome } from './onboarding-home-state.mjs';
import { readWorkbenchReply } from './native-workbench.js';
import { mountOnboardingDialogue } from './onboarding-dialogue.mjs';
import { quickCreateWarehouse, readQuickCreation } from './onboarding-quick.mjs';

const expired = () => Object.assign(new Error('HOST_SESSION_EXPIRED'), { code: 'HOST_SESSION_EXPIRED' });

export function createOnboardingUI({ bridge, enter, leave, show, openModels, onClose=()=>{} }) {
  const root = document.querySelector('#onboarding-shell');
  const storage = window.localStorage;
  const legacyQuick = completed => bridge?.legacyQuickCreation?.(completed);
  let active = null;
  const readers = identity => ({
    guided: new OnboardingDialogue({ storage, identity }),
    legacy: new OnboardingHome({ storage, identity }),
  });
  function records(identity) {
    const { guided, legacy } = readers(identity);
    guided.restore();
    legacy.restore();
    return { guided: guided.saved, legacy: legacy.state, quick: readQuickCreation(storage, identity, legacyQuick) };
  }
  function close() {
    const previous = active;
    active = null;
    previous?.page.close();
    root.hidden = true;
    if (previous) onClose();
  }
  function status(identity) {
    if (identity?.dataScope !== 'personal') return { drafts: {} };
    try {
      const { guided, legacy, quick } = records(identity);
      const drafts = { ...guided.warehouseDrafts };
      if (guided.warehouse) drafts[guided.warehouse.id] = guided;
      return { drafts, pending: Boolean(quick || guided.pending || guided.creation || guided.entryPending || legacy.creation), entryPending:guided.entryPending, quickCreated:!!quick?.warehouse };
    } catch {
      return { drafts: {}, pending: true };
    }
  }
  function open(identity, { warehouse = null, fresh = false, startUpdate = false } = {}) {
    if (identity?.dataScope !== 'personal' || active?.page.busy) return;
    let quick, legacy, guided, recoveryError;
    try { ({ quick, legacy, guided } = records(identity)); }
    catch { recoveryError = 'MODELING_LOCAL_RECORD_INVALID'; }

    // An unresolved write always opens its original flow, even via 新建.
    const legacyCreation = legacy?.creation && !guided?.pending && !guided?.creation && !quick;
    const guidedRecovery = guided?.pending || guided?.creation || guided?.entryPending;
    const requestedWarehouse = quick || legacyCreation || guidedRecovery || recoveryError ? null : warehouse;
    const returningToRules = startUpdate&&!!requestedWarehouse || !!requestedWarehouse && (guided?.warehouse?.id === requestedWarehouse.id
      ? guided.setupMode !== 'new' : guided?.warehouseDrafts[requestedWarehouse.id]?.setupMode !== 'new');

    const replacing = !!active;
    close();
    if (!show({ returningToRules, replacing })) return;
    const entry = {};
    active = entry;
    const isCurrent = () => active === entry;
    const call = async (action, input = {}) => {
      if (!isCurrent()) throw expired();
      const reply = await bridge.call(action, input);
      const result = action === 'warehouses' ? reply : readWorkbenchReply(reply);
      if (!isCurrent()) throw expired();
      return result;
    };
    const enterCurrent = async (value, options) => {
      if (!isCurrent()) throw expired();
      await enter(value, { ...options, isCurrent });
      if (!isCurrent()) throw expired();
    };
    const recoverLegacy = legacyCreation ? async () => {
      const home = new OnboardingHome({ storage, identity, call });
      await home.load();
      if (!home.state.error && home.state.creation) await home.create();
      if (home.state.error || !home.state.warehouse) {
        const definitive = !home.state.creation && !home.state.pending;
        throw Object.assign(new Error(home.state.error || '暂时无法读取创建结果，请重试。'), { definitive });
      }
      return home.state.warehouse;
    } : null;
    entry.page = mountOnboardingDialogue({
      host: root, storage, identity, call, warehouse: requestedWarehouse,
      fresh: fresh && !guidedRecovery && !quick && !legacyCreation && !recoveryError,
      quick, legacyCreation, recoveryError, recoverLegacy, startUpdate:startUpdate&&!!requestedWarehouse,
      onQuick: fields => quickCreateWarehouse({ storage, identity, call, enter: enterCurrent, legacyQuick, isCurrent, ...fields }),
      readQuick: () => readQuickCreation(storage, identity, legacyQuick),
      onEnter: enterCurrent,
      onModels: openModels && (async (warehouse, required) => {
        if (isCurrent()) await openModels(warehouse, {required,isCurrent});
      }),
      onComplete: () => { if (isCurrent()) close(); },
      onClose: () => { if (isCurrent()) { close(); leave(); } },
    });
    entry.page.focus();
  }
  return { open, status, close, reset: close, get visible() { return !!active; }, get busy() { return !!active?.page.busy; } };
}
