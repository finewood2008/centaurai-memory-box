// Cache namespaces only. Cloud login and the box enforce authorization.
const text = value => typeof value === 'string' && value.length > 0;

export function dataOwnerKey(state, serviceURL = '') {
  return state?.account?.phase === 'authenticated' && text(state.account.accountId)
    ? JSON.stringify([serviceURL, state.account.accountId]) : null;
}

export function dataInteractionKey(state, serviceURL = '') {
  const owner = dataOwnerKey(state, serviceURL);
  if (!owner || state?.phase !== 'ready' || !text(state.connection?.deviceId)) return null;
  return JSON.stringify([owner, state.account.clientId, state.connection.deviceId, state.connection.gatewayURL]);
}
