import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlatformClient} from '../platform.mjs';
import {createClient} from '../client.mjs';

const box = {deviceId:'box-102', identityDeviceId:'physical-102', displayName:'102',
  serviceUrl:'http://100.80.1.2:8088', ownershipEpoch:1, authorizationVersion:1, deviceRole:'owner'};
const advance = async (t, ms) => {
  t.mock.timers.tick(ms);
  for (let i=0;i<30;i++) await Promise.resolve();
};

function fixture(t) {
  let identity = null, networkState = {enabled:false, phase:'disabled', peers:[]};
  let agent={unavailable:false};
  const accountListeners = new Set(), networkListeners = new Set(), sessions = [];
  const sessionResult = () => ({enrollmentId:'enrollment', networkSessionId:'network', phase:'ready',
    managementUrl:'https://p2p.qeeshu.com', leaseExpiresAt:Date.now()/1000+300});
  const account = {
    getIdentity:()=>identity,
    snapshot:()=>identity ? {phase:'authenticated',...identity} : {phase:'signed_out'},
    subscribe:fn=>{accountListeners.add(fn);return ()=>accountListeners.delete(fn);},
    async loginPassword() {
      identity={accountId:'account',clientId:'client'};
      for(const fn of accountListeners) fn(this.snapshot());
      return this.snapshot();
    },
    async request({path}) {
      if(['/app-api/network/boxes','/app-api/network/boxes/prepare'].includes(path))
        return {boxes:[{...box,accessState:'ready'}]};
      if(path==='/app-api/network/restore') return sessionResult();
      if(path==='/app-api/network/devices') return {...sessionResult(),devices:[box]};
      throw Error('Unexpected fixture route: '+path);
    },
    close() {},
  };
  const network = {
    snapshot:()=>structuredClone(networkState),
    subscribe:fn=>{networkListeners.add(fn);return ()=>networkListeners.delete(fn);},
    async setEnabled(enabled) {
      networkState={enabled,phase:enabled?'ready':'disabled',peers:enabled?[{ip:'100.80.1.2',connected:true}]:[]};
      for(const fn of networkListeners) fn(networkState);
      return this.snapshot();
    },
    async refresh() {return this.snapshot();},
    async resolveEndpoint(input) {return {url:input.url,agent};},
    async networkChanged() {},
    close() {},
  };
  let transport;
  const platform = createPlatformClient({account,readPreference:async()=>true,
    createTransport() {
      transport=createClient({network,probe:async(_url,{agent})=>{if(agent.unavailable) throw Error('health_unavailable');},
        createGateway:async({session})=>({url:'http://127.0.0.1:18000',close(){session.close();}})});
      return {network,client:transport};
    },
    async createSession(input) {
      const session={closed:false,getToken(){return this.closed?'':'synthetic-session';},
        close(){this.closed=true;},expire(){this.close();input.onExpired('expired');}};
      sessions.push(session);
      return session;
    },
  });
  t.after(()=>platform.close());
  return {platform,sessions,disrupt(){agent.unavailable=true;agent={unavailable:false};},get transport(){return transport;}};
}

test('re-enabling an already enabled network keeps the selected box renewable without a manual reconnect',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const h=fixture(t);
  await h.platform.loginPassword({});
  await h.platform.connectBox(box.deviceId);
  assert.equal(h.platform.snapshot().phase,'ready');
  await h.platform.setNetworkEnabled(true);
  assert.equal(h.platform.snapshot().phase,'ready');

  // Model the transport generation replacement after a network interruption.
  // Public health succeeds through the new agent, then recovery must authorize
  // through the actual platform-owned factory saved by the original connect.
  h.disrupt();
  await advance(t,30000);
  for(let i=0;i<6&&h.transport.snapshot().phase!=='ready';i++) await advance(t,10000);
  const automatic=h.transport.snapshot();

  // The reported symptom has a healthy current path and manually reconnects.
  await h.platform.disconnect();
  await h.platform.connectBox(box.deviceId);
  assert.equal(h.platform.snapshot().phase,'ready');
  assert.equal(h.sessions.length>=2,true);
  assert.equal(automatic.phase,'ready','automatic renewal must not keep retrying a permanently cancelled factory');
});
