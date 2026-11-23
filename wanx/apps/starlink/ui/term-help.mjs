import { getStarlinkTerm, starlinkGlossary } from '../shared/starlink-glossary.mjs';
import { starxiaotuIcon } from './starxiaotu.mjs';

const escape = value => value.replace(/[&<>"']/g, character =>
  ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[character]);

export function starxiaotuTermMarker(key) {
  const term = getStarlinkTerm(key);
  if (!term) return '';
  return '<button type="button" class="sx-term" data-starxiaotu-term="' + escape(term.key) +
    '" aria-label="向星小图了解' + escape(term.label) + '" aria-description="' + escape(term.definition) +
    '" title="' + escape(term.label + "：" + term.definition) + '">' + starxiaotuIcon + '</button>';
}

export function mountTermGlossary(dialog) {
  const list = dialog.querySelector('#starlink-glossary-list');
  const search = dialog.querySelector('#starlink-glossary-search');
  const empty = dialog.querySelector('#starlink-glossary-empty');
  list.innerHTML = starlinkGlossary.map((group, index) =>
    '<details class="term-group"' + (index === 0 ? ' open' : '') + '><summary>' + escape(group.title) +
    '</summary><dl>' + group.terms.map(term =>
      '<div class="term-row"><dt>' + escape(term.label) + starxiaotuTermMarker(term.key) + '</dt><dd>' +
      escape(term.definition) + '</dd></div>').join('') + '</dl></details>').join('');
  const groups = [...list.querySelectorAll('.term-group')];
  let openGroups;
  search.addEventListener('input', () => {
    const query = search.value.trim().toLowerCase();
    if (query && !openGroups) openGroups = groups.map(group => group.open);
    let matches = 0;
    groups.forEach((group, index) => {
      const rows = [...group.querySelectorAll('.term-row')];
      for (const row of rows) {
        row.hidden = !row.textContent.toLowerCase().includes(query);
        if (!row.hidden) matches++;
      }
      group.hidden = rows.every(row => row.hidden);
      if (query) group.open = !group.hidden;
      else if (openGroups) group.open = openGroups[index];
    });
    if (!query) openGroups = undefined;
    empty.hidden = matches !== 0;
  });
}
