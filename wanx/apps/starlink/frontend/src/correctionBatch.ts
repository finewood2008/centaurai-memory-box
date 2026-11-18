import {editable, type Item, type Page} from './corrections.ts';

export type BatchAction = 'review' | 'properties' | 'relations';
export type BatchPlan = {upserts: Item[]; removeIds: string[]; description: string};
export function canReviewWarnings(item: Item) {
  return !!item.issues?.some(i => i.severity === 'warning' && !i.reviewed) && !item.issues?.some(i => i.severity === 'error');
}

// Do not submit partial page results or combine different draft revisions.
export async function readBatchItems(read: (offset: number) => Promise<Page<Item>>, revision: number) {
  const items: Item[] = [], seen = new Set<string>();
  let total: number | undefined;
  do {
    const page = await read(items.length);
    if (page.revision !== revision || !Number.isSafeInteger(page.total) || page.total < 0 ||
        (total !== undefined && page.total !== total) || page.offset !== items.length)
      throw new Error('草稿已变化，请重新读取校验结果。');
    total = page.total;
    if (total > 10000) throw new Error('草稿超过批量读取范围，请在条目编辑器中分批处理。');
    for (const item of page.items) {
      if (seen.has(item.id) || !Array.isArray(item.issues)) throw new Error('校验条目响应不完整，请重新读取。');
      seen.add(item.id); items.push(item);
    }
    if (items.length > total || (!page.items.length && items.length < total)) throw new Error('校验条目响应不完整，请重新读取。');
  } while (items.length < total);
  return items;
}

export function buildBatchPlan(items: Item[], ids: string[], action: BatchAction, note: string, properties: string[] = []): BatchPlan {
  if (!ids.length || ids.length > 100 || new Set(ids).size !== ids.length) throw new Error('每次请选择 1–100 条事实。');
  const selected = ids.map(id => {
    const item = items.find(i => i.id === id);
    if (!item) throw new Error('所选事实已变化，请重新读取。');
    return item;
  });
  if (!note.trim() || note.length > 1500) throw new Error('请填写不超过 1500 字的处理说明。');
  if (action === 'review') {
    if (!selected.every(canReviewWarnings)) throw new Error('只能批量核对没有阻塞错误的待复核事实；错误不能通过说明放行。');
    return {upserts: selected.map(i => ({...editable(i), review_note: note.trim()})), removeIds: [], description: `为 ${selected.length} 条事实保存共同核对说明；不修改事实内容。`};
  }
  if (action === 'relations') {
    if (!selected.every(i => i.kind === 'relation')) throw new Error('此操作仅排除关系，不删除实体。');
    return {upserts: [], removeIds: ids.slice(), description: `从当前草稿排除 ${selected.length} 条关系；实体保留。发布后这些关系将不属于本篇材料的结果。`};
  }
  if (action !== 'properties' || !properties.length) throw new Error('请明确选择要移除的属性。');
  const upserts = selected.flatMap(i => {
    const values = i.payload.properties;
    if (!values || typeof values !== 'object' || Array.isArray(values)) return [];
    if (!properties.some(key => Object.hasOwn(values, key))) return [];
    const item = editable(i);
    item.payload.properties = Object.fromEntries(Object.entries(values).filter(([key]) => !properties.includes(key)));
    item.review_note = ''; // Content changed: never carry an old semantic approval forward.
    return [item];
  });
  if (!upserts.length) throw new Error('所选事实中没有这些属性。');
  return {upserts, removeIds: [], description: `从 ${upserts.length} 条事实移除所选属性 ${properties.join('、')}，保留实体、关系及其他属性；原核对说明将清除，保存后重新校验。`};
}
