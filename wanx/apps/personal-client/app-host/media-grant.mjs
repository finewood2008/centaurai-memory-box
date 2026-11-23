// The scoped grant belongs only to the media service. Match its literal route
// grammar so a request for another service never receives this credential.
export function acceptsMediaGrant(path) {
  const route = path.split("?", 1)[0];
  return (
    /^\/api\/services\/wanx\.media\/v1\/(?:capabilities|asr\/sessions|delegations(?:\/[A-Za-z0-9_-]+)?|grant\/self|jobs(?:\/[A-Za-z0-9_-]+(?:\/(?:input|submit|result|retry))?)?)$/.test(route) ||
    /^\/api\/services\/wanx\.media\/v1\/(?:summaries|summary-templates(?:\/(?:default|builtin-default|[a-f0-9]{32}))?)$/.test(route)
  );
}

export function isMediaAsrStream(path) {
  return /^\/api\/services\/wanx\.media\/v1\/asr\/sessions\/[a-f0-9]{32}\/stream$/.test(path);
}
