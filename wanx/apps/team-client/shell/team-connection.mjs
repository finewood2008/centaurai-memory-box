const fail = code => Object.assign(new Error(code), { code });

// Team access uses the authenticated cloud account and the box's existing ACL.
export function createTeamConnection({ base }) {
  const snapshot = () => {
    const state = { ...base.snapshot() };
    delete state.dataIdentity;
    delete state.identitySecurity;
    return { ...state, team: {} };
  };
  const trusted = () => {
    const state = base.snapshot();
    if (state.account?.phase !== 'authenticated') throw fail('ACCOUNT_LOGIN_REQUIRED');
    if (!state.connection?.deviceId || state.connection.authorization === 'local-trust-v1') throw fail('NETWORK_NOT_READY');
  };
  const connect = async (deviceId, options) => {
    await base.connectBox(deviceId, options);
    return snapshot();
  };
  const own = {
    snapshot,
    isTeamDirect: () => false,
    async initialize() { await base.initialize(); return snapshot(); },
    connect: input => connect(input?.deviceId),
    connectBox: connect,
    async applicationContext(...args) { trusted(); return base.applicationContext(...args); },
    async applicationConnection(...args) { trusted(); return base.applicationConnection(...args); },
    async applicationRequest(...args) { trusted(); return base.applicationRequest(...args); },
    async applicationStream(...args) { trusted(); return base.applicationStream(...args); },
    subscribe(listener) { return base.subscribe(() => listener(snapshot())); },
  };
  return new Proxy(base, { get(target, key) {
    return key in own ? own[key] : typeof target[key] === 'function' ? target[key].bind(target) : target[key];
  } });
}
