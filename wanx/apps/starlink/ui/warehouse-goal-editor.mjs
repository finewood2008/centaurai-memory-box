import {scopePatchError} from '../shared/onboarding-contract.mjs';

export function openWarehouseGoalEditor({request, onSaved, onDismiss}) {
  const dialog = document.querySelector('#warehouse-goal-template').content.firstElementChild.cloneNode(true);
  const field = dialog.querySelector('textarea');
  const status = dialog.querySelector('[role=status]');
  const save = dialog.querySelector('[type=submit]');
  const cancel = dialog.querySelector('[type=button]');
  let base, pending, busy = false;

  function notice(text) {
    status.textContent = text;
    status.hidden = !text;
  }
  function accessMessage(error) {
    if (['SEMANTICA_OPERATION_NOT_ALLOWED', 'SEMANTICA_UPGRADE_REQUIRED'].includes(error?.code))
      return '当前服务版本尚不支持此操作，请更新后再试。';
    if (error?.status === 403 || error?.status === 401)
      return '当前账号无法编辑此星图目标，请检查账号和权限。';
    return '';
  }
  function goalLines() {
    return field.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  }
  function unchanged() {
    if (!base || pending) return false;
    const saved = base.warehouse_scope.purposes.join('\n');
    return field.value === saved || goalLines().join('\n') === saved;
  }
  field.addEventListener('input', () => { save.disabled = busy || unchanged(); });
  function working(value) {
    busy = value;
    field.disabled = value || !base;
    save.disabled = value || unchanged();
    save.textContent = base ? '保存' : '重新读取';
  }
  async function load(conflict = false) {
    working(true);
    try {
      const context = await request('onboarding-context');
      if (!dialog.open) return;
      const purposes = context?.warehouse_scope?.purposes;
      if (!Array.isArray(purposes) || !context.base_ontology_id || !Number.isSafeInteger(context.purpose_revision)) {
        base = null;
        notice('盒端未返回可编辑的星图目标，请检查盒端服务版本。');
        return;
      }
      base = context;
      const current = purposes.join('\n');
      if (!conflict) field.value = current;
      if (conflict && unchanged()) notice('你的输入与盒端最新目标一致，可直接关闭。');
      else notice(conflict ? '星图目标或本体已更新。当前已保存的目标：\n' +
        (current || '尚未填写') + '\n已保留你的输入，核对后可再次保存。' : '');
    } catch (error) {
      if (!dialog.open) return;
      base = null;
      notice(accessMessage(error) || '暂时无法读取星图目标，请重新读取。');
    } finally {
      working(false);
      if (dialog.open && base) field.focus();
    }
  }
  cancel.onclick = () => dialog.close();
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (dialog.returnValue !== 'saved') onDismiss?.();
  }, {once:true});
  dialog.querySelector('form').onsubmit = async event => {
    event.preventDefault();
    if (busy) return;
    if (!base) { await load(Boolean(field.value)); return; }
    if (unchanged()) return;
    const purposes = goalLines();
    if (!purposes.length || scopePatchError({purposes})) {
      notice('请填写 1–6 条目标，每条最多 300 字。');
      field.focus();
      return;
    }
    const text = purposes.join('\n');
    if (!pending || pending.changes.purposes.join('\n') !== text) {
      pending = {operation_id:crypto.randomUUID(), expected_revision:base.purpose_revision,
        base_ontology_id:base.base_ontology_id, changes:{purposes}, confirmed:true};
    }
    working(true);
    cancel.disabled = true;
    notice('正在保存…');
    try {
      const result = await request('onboarding-scope-publish', pending);
      if (!dialog.open) return;
      if (result?.status !== 'published' || result.ontology_id !== base.base_ontology_id ||
          result.purpose_revision !== base.purpose_revision + 1 || result.scope?.purposes?.join('\n') !== text)
        throw Error('INVALID_RECEIPT');
      dialog.close('saved');
      onSaved(result);
    } catch (error) {
      if (!dialog.open) return;
      if (error.code === 'MODELING_REVISION_CHANGED') {
        pending = null;
        await load(true);
      } else {
        notice(accessMessage(error) || (error.code === 'MODELING_INVALID_REQUEST' ? '盒端未接受目标，请确认盒端已更新后再保存。' :
          '保存结果尚未确认，已保留输入。请重试保存。'));
      }
    } finally {
      working(false);
      cancel.disabled = false;
    }
  };
  dialog.addEventListener('cancel', event => { if (cancel.disabled) event.preventDefault(); });
  document.body.append(dialog);
  dialog.showModal();
  void load();
}
