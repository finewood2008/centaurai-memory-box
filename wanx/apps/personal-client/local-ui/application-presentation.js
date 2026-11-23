// Presentation is supplied by the trusted main process, never derived from IDs.
(() => {
  const labels = Object.freeze({dev: '联调', prod: '正式'});
  function environment(item) {
    const value = item?.presentation;
    return value && Object.keys(value).sort().join() === 'environment,label'
      && Object.hasOwn(labels, value.environment) && value.label === labels[value.environment]
      ? value.environment : null;
  }
  function badge(item) {
    const value = environment(item);
    return value ? `<span class="application-environment-badge" data-environment="${value}">${labels[value]}</span>` : '';
  }
  window.wanxApplicationPresentation = Object.freeze({environment, badge});
})();
