// Native disclosure menus keep existing action handlers and permission checks.
(() => {
  const openMenus = () => Array.from(document.querySelectorAll('details[data-wanx-actions][open]'));
  function close(menu, focus = false) {
    menu.open = false;
    if (focus) menu.querySelector('summary')?.focus();
  }
  document.addEventListener('click', event => {
    const menu = event.target.closest?.('details[data-wanx-actions]');
    for (const other of openMenus()) if (other !== menu) close(other);
    // Close before the delegated action runs; do not cancel or duplicate it.
    if (menu && event.target.closest?.('button:not(:disabled)')) close(menu);
  }, true);
  document.addEventListener('keydown', event => {
    const menus = openMenus();
    if (event.key === 'Escape' && menus.length) {
      event.preventDefault();
      event.stopImmediatePropagation();
      for (const menu of menus) close(menu, true);
      return;
    }
    const menu = event.target.closest?.('details[data-wanx-actions]');
    if (!menu || !['ArrowDown', 'ArrowUp'].includes(event.key) || event.target.closest?.('select,input,textarea')) return;
    event.preventDefault();
    menu.open = true;
    const items = Array.from(menu.querySelectorAll('.wanx-menu-panel button:not(:disabled), .wanx-menu-panel select'));
    const index = items.indexOf(document.activeElement);
    const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : items.length - 1) : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }, true);
})();
