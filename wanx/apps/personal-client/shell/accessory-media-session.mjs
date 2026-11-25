import path from 'node:path';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { createForegroundMediaGrantReader } from '../app-host/media-grant.mjs';
import { createApplicationSession } from '../app-host/session.mjs';
import { createSecureAccountStore } from '../account/store.mjs';

const recordingApplicationId = 'centaurai.memobox.recording';
const digest = value => createHash('sha256').update(value).digest('hex');
const instanceId = /^[a-zA-Z0-9_.-]{1,128}$/;

// The installer stages an owner-readable package here. No renderer receives a path or secret.
async function deliveredPackage(filename) {
  let handle;
  try {
    handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 16384 || (process.platform !== 'win32' &&
      (stat.uid !== process.getuid() || (stat.mode & 0o077)))) throw new Error();
    return JSON.parse(await handle.readFile('utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error('宿主收到的媒体授权包无法安全读取，请联系安装方。');
  } finally { await handle?.close(); }
}

export async function recordingSession({app, client, safeStorage}) {
  if (client.snapshot().phase !== 'ready') return null;
  let activeGrant, foregroundGrant;
  const session = await createApplicationSession({
    applicationId:recordingApplicationId, hostApplicationId:'ai.centuarai.wanx.client', installPath:app.getAppPath(),
    capabilities:['identity.read','http.request'],
    mediaGrant:() => activeGrant,
    foregroundMediaGrant:() => foregroundGrant,
    createConnection:({applicationId, ...options}) => client.applicationConnection(applicationId, options),
  });
  try {
    const context = session.assertLive();
    const owner = context.principalId || context.accountId;
    if (!context.boxId || !owner) throw new Error('请检查当前盒子和账号。');
    const dir = path.join(app.getPath('userData'), 'accessories', digest(JSON.stringify([context.boxId, owner, context.dataIdentity?.profileId])));
    const store = createSecureAccountStore({filePath:path.join(dir,'media-grant.enc'),safeStorage});
    const existing = await store.load();
    // Keep an installed legacy instance so its history and paid summary settings still resolve.
    const handoff = path.join(dir,'recording-media-grant.json');
    const claimed = handoff + '.importing';
    try { await rename(handoff, claimed); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
    const delivered = await deliveredPackage(claimed);
    const grant = delivered || existing;
    if (grant) {
      if (typeof grant.grant !== 'string' || !/^[!-~]{1,2048}$/.test(grant.grant) ||
          typeof grant.instance !== 'string' || !instanceId.test(grant.instance))
        throw new Error('既有录音连接凭据格式无效。');
      activeGrant = grant.grant;
    } else {
      foregroundGrant = await createForegroundMediaGrantReader(dir)(recordingApplicationId);
    }
    session.assertLive();
    const env = session.environment;
    const response = await fetch(env.WANX_HOST_BASE_URL + '/api/services/wanx.media/v1/capabilities', {
      headers:{Authorization:'Bearer '+env.WANX_HOST_TOKEN}, redirect:'error',signal:AbortSignal.timeout(12000),
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      const code = typeof detail?.code === 'string' && /^[A-Z][A-Z_0-9]{1,79}$/.test(detail.code)
        ? detail.code : 'HTTP_' + response.status;
      throw Object.assign(new Error('盒端转写连接失败（' + code + '）。'), {code});
    }
    const info = await response.json();
    if (typeof info?.instance !== 'string' || !instanceId.test(info.instance) ||
        (grant && info.instance !== grant.instance) || !Array.isArray(info.capabilities) ||
        info.processingLocation !== 'box') throw new Error('盒端媒体服务返回的录音实例无效。');
    session.assertLive();
    if (delivered) {
      await store.save({instance:grant.instance, grant:grant.grant});
      await unlink(claimed);
    }
    session.assertLive();
    return {session, data:path.join(dir,'projects',digest(info.instance)),
      env:{...env, MEMOBOX_MEDIA_INSTANCE:info.instance, MEMOBOX_HOST_SDK_PATH:path.join(app.getAppPath(),'host-sdk/index.cjs'),
        ...(!grant ? {MEMOBOX_MEDIA_SUMMARY_ON_REQUEST:'1'} : {})}};
  } catch (err) { await session.close(); throw err; }
}
