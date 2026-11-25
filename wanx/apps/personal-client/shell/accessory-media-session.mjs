import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, unlink, writeFile } from 'node:fs/promises';
import { createApplicationSession } from '../app-host/session.mjs';
import { createSecureAccountStore } from '../account/store.mjs';

export const recordingApplication = Object.freeze({
  applicationId: 'centaurai.memobox.recording',
  mediaCapabilities: ['audio.transcribe', 'audio.transcribe.streaming'],
});
const digest = value => createHash('sha256').update(value).digest('hex');

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

export async function recordingSession({app, client, dialog, window, safeStorage}, interactive) {
  if (client.snapshot().phase !== 'ready') {
    if (interactive) throw new Error('请在记忆盒子客户端的「盒子」页连接目标盒子，然后再次授权。录音已保留在本机。');
    return null;
  }
  let activeGrant;
  const session = await createApplicationSession({
    applicationId:recordingApplication.applicationId, hostApplicationId:'ai.centuarai.wanx.client', installPath:app.getAppPath(),
    capabilities:['identity.read','http.request'],
    mediaGrant:() => activeGrant,
    createConnection:({applicationId, ...options}) => client.applicationConnection(applicationId, options),
  });
  try {
    const context = session.assertLive();
    const owner = context.principalId || context.accountId;
    if (!context.boxId || !owner) throw new Error('请检查当前盒子和账号。');
    const dir = path.join(app.getPath('userData'), 'accessories', digest(JSON.stringify([context.boxId, owner, context.dataIdentity?.profileId])));
    const store = createSecureAccountStore({filePath:path.join(dir,'media-grant.enc'),safeStorage});
    const consent = createSecureAccountStore({filePath:path.join(dir,'media-consent.enc'),safeStorage});
    const existing = await store.load();
    let decision = await consent.load();
    if (!existing && !decision?.allowed) {
      if (!interactive) { await session.close(); return null; }
      const answer = await dialog.showMessageBox(window, {type:'question', title:'半人马AI记忆盒子应用授权', message:'允许录音智能体使用当前盒子的语音转写？',
        detail:'授权文件转写和实时字幕。确认后，智能体可将你录制或导入的音频交给当前盒子处理。',
        buttons:['允许','暂不授权'], defaultId:0, cancelId:1});
      session.assertLive();
      if (answer.response !== 0) { await session.close(); return null; }
      decision = {allowed:true, applicationId:recordingApplication.applicationId, capabilities:recordingApplication.mediaCapabilities};
      await consent.save(decision);
    }
    const handoff = path.join(dir,'recording-media-grant.json');
    const claimed = handoff + '.importing';
    try { await rename(handoff, claimed); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
    const delivered = await deliveredPackage(claimed);
    const grant = delivered || existing;
    if (!grant) {
      session.assertLive();
      // The Bridge binds the media scope to its authenticated user and personal space.
      // Give the trusted installer the verified scope without exporting session credentials.
      if (context.clientId && context.user?.id != null) {
        const binding = { applicationId:recordingApplication.applicationId, boxId:context.boxId,
          userId:String(context.user.id), spaceId:context.user.spaceId || context.user.space_id || 'personal',
          instance:'memobox-recording-' + digest(JSON.stringify([context.clientId, owner, context.boxId, context.dataIdentity?.profileId])).slice(0,32),
          capabilities:recordingApplication.mediaCapabilities };
        const requestFile = path.join(dir,'recording-media-request.json');
        const temporary = requestFile + '.' + randomUUID();
        try {
          await writeFile(temporary, JSON.stringify(binding), {flag:'wx',mode:0o600});
          session.assertLive();
          await rename(temporary, requestFile);
        } finally { await unlink(temporary).catch(err => { if (err.code !== 'ENOENT') throw err; }); }
      }
      throw Object.assign(new Error('已记住你的授权，等待安装方向客户端宿主交付本应用实例的媒体凭据。'), {code:'MEDIA_GRANT_PENDING'});
    }
    if (typeof grant.grant !== 'string' || !/^[!-~]{1,2048}$/.test(grant.grant) || typeof grant.instance !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(grant.instance)) throw new Error('宿主收到的媒体授权包格式无效。');
    activeGrant = grant.grant;
    const env = session.environment;
    const response = await fetch(env.WANX_HOST_BASE_URL + '/api/services/wanx.media/v1/capabilities', {
      headers:{Authorization:'Bearer '+env.WANX_HOST_TOKEN}, redirect:'error',signal:AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error('盒端未接受当前媒体授权（HTTP '+response.status+'）。');
    const info = await response.json();
    if (info.instance !== grant.instance || !Array.isArray(info.capabilities) || info.processingLocation !== 'box') throw new Error('媒体服务返回的授权实例不匹配。');
    session.assertLive();
    if (delivered) {
      await store.save({instance:grant.instance, grant:grant.grant});
      await unlink(claimed);
    }
    session.assertLive();
    return {session, data:path.join(dir,'projects',digest(grant.instance)),
      env:{...env, MEMOBOX_MEDIA_INSTANCE:grant.instance, MEMOBOX_HOST_SDK_PATH:path.join(app.getAppPath(),'host-sdk/index.cjs')}};
  } catch (err) { await session.close(); throw err; }
}
