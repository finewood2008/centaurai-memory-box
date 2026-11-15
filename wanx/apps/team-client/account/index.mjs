import { publicProfile, validateProfilePatch } from "./profile.mjs";
import { decodeCreditEnvelope } from "./credit-wallet.mjs";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";

export const DEFAULT_CONSUMER_URL = "https://boss.nexusaos.qitus.cn/prod-api";
const failure = (code, status) =>
  Object.assign(new Error(code), { code, status });

const feedbackFailure = (status, message, rate = {}) => {
  const code = ({ 400: "FAQ_FEEDBACK_INVALID_REQUEST", 409: "FAQ_FEEDBACK_IDEMPOTENCY_CONFLICT",
    413: "FAQ_FEEDBACK_TOO_LARGE", 429: "FAQ_FEEDBACK_RATE_LIMITED", 601: "FAQ_FEEDBACK_INVALID_CONTENT" })[status]
    || (status >= 500 || status === 404 || status === 405 ? "FAQ_FEEDBACK_UNAVAILABLE" : "FAQ_FEEDBACK_INVALID_RESPONSE");
  const error = failure(code, status || 502);
  if (status === 601 && typeof message === "string")
    error.userMessage = [...message.replace(/[\x00-\x1f\x7f]/g, "").trim()].slice(0, 200).join("");
  if (status === 429) {
    const seconds = Number(rate.retryAfterSeconds);
    error.retryAfterSeconds = Number.isFinite(seconds) && seconds > 0 ? Math.min(86400, Math.ceil(seconds)) : 60;
    error.limitScope = rate.limitScope === "day" ? "day" : "minute";
  }
  return error;
};
function feedbackBody(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some(key => !["content", "contact", "categoryId", "itemId"].includes(key)))
    throw feedbackFailure(400);
  if (typeof input.content !== "string" || (input.contact != null && typeof input.contact !== "string"))
    throw feedbackFailure(400);
  const content = input.content.replace(/\r\n?/g, "\n").trim(), contact = input.contact?.trim() || null;
  if (!content || [...content].length > 2000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content))
    throw feedbackFailure(601, "请填写 1–2000 字的问题描述，且不要包含非法控制字符。");
  if (contact && ([...contact].length > 128 || /[\x00-\x1f\x7f]/.test(contact)))
    throw feedbackFailure(601, "联系方式最多 128 字，且不能包含换行或控制字符。");
  for (const key of ["categoryId", "itemId"]) {
    const id = input[key];
    if (id != null && !(Number.isSafeInteger(id) && id > 0) &&
        !(typeof id === "string" && /^[1-9][0-9]{0,18}$/.test(id) && BigInt(id) <= 9223372036854775807n))
      throw feedbackFailure(400);
  }
  return { content, contact, categoryId: input.categoryId ?? null, itemId: input.itemId ?? null };
}

const terminalSessionReason = code => ["AUTH_CLIENT_REPLACED", "AUTH_CLIENT_RETIRED", "AUTH_CLIENT_REAUTH_REQUIRED"].includes(code);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const isGrantRequest = ({ method, path } = {}) => method === "POST" &&
  /^\/app-api\/devices\/[A-Za-z0-9._-]+\/wanx\/sso-grants$/.test(path || "");
const encode = (value) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

export function consumerSignature({
  identity,
  accountId,
  method,
  path,
  body = "",
  now = Date.now(),
  nonce = randomUUID(),
}) {
  const url = new URL(path, "https://consumer.invalid");
  const versioned = url.pathname.startsWith("/app-api/v1/");
  const timestamp = String(Math.floor(now / 1000));
  const bodyHash = hash(body);
  const query = [...url.searchParams]
    .sort(
      ([a, av], [b, bv]) =>
        Buffer.compare(Buffer.from(a), Buffer.from(b)) ||
        Buffer.compare(Buffer.from(av), Buffer.from(bv)),
    )
    .map(([key, value]) => `${encode(key)}=${encode(value)}`)
    .join("&");
  const version = versioned
    ? "NEXUSAOS-CONSUMER-APP-V1"
    : "NEXUSAOS-CONSUMER-V1";
  const canonical = [
    version,
    accountId,
    identity.clientId,
    method.toUpperCase(),
    decodeURI(url.pathname),
    ...(versioned ? [query] : []),
    timestamp,
    nonce,
    bodyHash,
  ].join("\n");
  return {
    "X-Nexus-Client-Id": identity.clientId,
    "X-Nexus-Timestamp": timestamp,
    "X-Nexus-Nonce": nonce,
    "X-Nexus-Body-SHA256": bodyHash,
    "X-Nexus-Signature": sign(
      "sha256",
      Buffer.from(canonical),
      identity.privateKey,
    ).toString("base64"),
    ...(versioned ? { "X-Nexus-Signature-Version": version } : {}),
  };
}

const ownershipId = (value) => typeof value === "string" && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(value);
const claimDeviceId = (value) => typeof value === "string" && /^[A-Za-z0-9._-]{1,36}$/.test(value) && ![".", ".."].includes(value);
function transferView(value) {
  if (!value || !ownershipId(value.transferId) || !ownershipId(value.deviceId) ||
      !["incoming", "outgoing"].includes(value.direction) ||
      !["pending_target", "completed", "expired", "cancelled", "revoked"].includes(value.state) ||
      typeof value.retainData !== "boolean" || !Number.isSafeInteger(value.ownershipEpoch) ||
      value.ownershipEpoch < 1 || !Number.isFinite(Date.parse(value.expiresAt)))
    throw failure("ACCOUNT_INVALID_RESPONSE");
  return Object.fromEntries(["transferId", "deviceId", "direction", "state", "retainData", "ownershipEpoch", "expiresAt", "createdAt", "completedAt"].map(key => [key, value[key]]));
}

function newIdentity() {
  const keys = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return {
    clientId: randomUUID(),
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
  };
}

/** Consumer protocol without the retired connectivity SDK. Keep this in main. */
export function createAccount({
  baseURL = DEFAULT_CONSUMER_URL,
  store,
  fetch: fetcher = globalThis.fetch,
  emit = () => {},
  platform = process.platform,
  deviceModel = "万象连接",
  now = Date.now,
  measure = (_step, operation) => operation(),
  onGrantTiming = () => {},
  getClientUpdateContext = () => null,
  onClientUpdateRequired = () => {},
} = {}) {
  let base;
  try {
    base = new URL(baseURL);
  } catch {
    throw failure("ACCOUNT_INVALID_URL");
  }
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw failure("ACCOUNT_INVALID_URL");
  const prefix = base.pathname.replace(/\/$/, "");
  let record = null,
    epoch = 0,
    closed = false,
    refreshPromise = null;
  let logoutCleanup = Promise.resolve();
  let passwordUpdate = null;
  let feedbackSubmission = null, feedbackPending = null;
  let vault = { version: 2, baseURL: base.href, accounts: {}, active: null };
  let loaded = false;
  let loading = null;
  let state = {
    phase: "signed_out",
    accountId: null,
    clientId: null,
    devices: [],
    reason: null,
    logoutPending: false,
  };
  const pending = new Set();
  const listeners = new Set();
  let writes = Promise.resolve();
  const snapshot = () => structuredClone({
    ...state,
    maskedPhone: state.phase === "authenticated" && record?.phone
      ? `${record.phone.slice(0, 3)}****${record.phone.slice(-4)}` : null,
    profile: state.phase === "authenticated" && record?.session
      ? publicProfile(vault.profiles?.[record.session.accountId]) : null,
  });
  const publish = (patch) => {
    state = { ...state, ...patch };
    emit(snapshot());
    for (const listener of listeners) listener(snapshot());
    return snapshot();
  };
  const assert = (generation) => {
    if (closed || generation !== epoch) throw failure("ACCOUNT_CANCELLED");
  };
  const persist = (value, patch = {}, { finishAfterCancellation = false } = {}) => {
    const generation = epoch;
    const next = writes.then(async () => {
      if (generation !== epoch && !finishAfterCancellation) return;
      const candidate = {
        ...vault,
        ...patch,
        accounts: { ...vault.accounts },
        active: value?.session
          ? { phone: value.phone, session: value.session }
          : null,
      };
      if (value) candidate.accounts[value.phone] = { identity: value.identity };
      await store.save(candidate);
      vault = candidate;
    });
    writes = next.catch(() => {});
    return next;
  };
  async function loadVault(generation) {
    if (loaded) return;
    loading ??= store.load().finally(() => { loading = null; });
    const saved = await loading;
    assert(generation);
    if (loaded) return;
    if (saved) {
      if (
        saved.version !== 2 ||
        saved.baseURL !== base.href ||
        !saved.accounts ||
        typeof saved.accounts !== "object"
      )
        throw failure("ACCOUNT_INVALID_STORED_SESSION");
      vault = saved;
    }
    loaded = true;
  }
  const cancel = () => {
    epoch++;
    for (const controller of pending) controller.abort();
    pending.clear();
    refreshPromise = null;
  };
  async function endReplacedSession(code, generation) {
    if (!terminalSessionReason(code) || generation !== epoch || !record?.session) return;
    cancel();
    record = null;
    // This revocation must finish even when close cancels the epoch while an
    // older refresh save is in flight. New logins drain this same write queue.
    const cleared = persist(null, { signedOutReason: code }, { finishAfterCancellation: true });
    publish({ phase: "signed_out", accountId: null, clientId: null, devices: [],
      reason: code, logoutPending: false });
    await cleared;
  }
  function route(path) {
    // Only these Consumer paths are accepted; no host, fragments or traversal.
    if (
      typeof path !== "string" ||
      !/^\/app-api\/[A-Za-z0-9_/?=&.%:-]+$/.test(path) ||
      /%2f|%5c|%2e|\/\.\.?($|\/)/i.test(path)
    )
      throw failure("ACCOUNT_INVALID_PATH");
    const parsed = new URL(path, base.origin);
    if (
      parsed.origin !== base.origin ||
      !parsed.pathname.startsWith("/app-api/")
    )
      throw failure("ACCOUNT_INVALID_PATH");
    return `${base.origin}${prefix}${path}`;
  }
  async function wire(
    {
      method = "GET",
      path,
      body,
      authenticated = true,
      clientContext = false,
      signal,
      responseMetadata = false,
      ifNoneMatch,
      acceptNotModified = false,
      exposeEtag = false,
      cacheMode,
      idempotencyKey,
    },
    generation,
    auth = record,
    detached = false,
  ) {
    const checkGeneration = () => { if (!detached) assert(generation); };
    const url = route(path);
    const grantRequest = isGrantRequest({ method, path });
    const timed = (stage, operation) => grantRequest ? measure(`account.grant.${stage}`, operation) : operation();
    const creditRoute = path.startsWith("/app-api/v1/credits/");
    const faqRoute = path === "/app-api/faq";
    const faqFeedbackRoute = path === "/app-api/faq/feedback";
    const faqFailure = status => failure(status === 429 ? "FAQ_RATE_LIMITED" : "FAQ_UNAVAILABLE", status);
    checkGeneration();
    const text = body === undefined ? "" : JSON.stringify(body);
    const controller = new AbortController();

    const signals = [
      controller.signal,
      AbortSignal.timeout(20000),
      ...(signal ? [signal] : []),
    ];
    const headers = {
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    };
    if (ifNoneMatch) headers["If-None-Match"] = ifNoneMatch;
    if (idempotencyKey !== undefined) {
      if (
        typeof idempotencyKey !== "string" ||
        !(creditRoute ? /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/ : /^[\w-]{1,128}$/).test(idempotencyKey)
      )
        throw failure("ACCOUNT_INVALID_INPUT");
      headers["Idempotency-Key"] = idempotencyKey;
    }
    if (clientContext && faqFeedbackRoute) {
      const client = getClientUpdateContext();
      if (client && typeof client === "object") {
        const text = value => typeof value === "string" && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value) ? value : undefined;
        headers["X-Wanx-Client"] = JSON.stringify({ product: "wanx-client",
          edition: ["personal", "team"].includes(client.edition) ? client.edition : undefined,
          currentVersion: text(client.productVersion), buildId: text(client.buildId), channel: text(client.channel),
          platform: { os: text(client.platform), arch: text(client.arch), osVersion: text(client.osVersion),
            osProductVersion: text(client.osProductVersion) }, backendContract: 1,
          hostProtocol: client.hostProtocol, securityEpoch: client.securityEpoch });
      }
    }
    if (authenticated) {
      if (!auth?.session) throw failure("ACCOUNT_LOGIN_REQUIRED");
      const client = getClientUpdateContext();
      if (client?.packaged && client.distributionClass === "formal") {
        headers["X-Wanx-Client"] = JSON.stringify({ product: "wanx-client", channel: client.channel,
          platform: { os: client.platform, arch: client.arch, osVersion: client.osVersion },
          currentVersion: client.productVersion, backendContract: 1, hostProtocol: client.hostProtocol,
          securityEpoch: client.securityEpoch });
      }
      Object.assign(
        headers,
        consumerSignature({
          identity: auth.identity,
          accountId: auth.session.accountId,
          method,
          path,
          body: text,
          now: now(),
        }),
        { Authorization: `Bearer ${auth.session.accessToken}` },
      );
    }
    if (!detached) pending.add(controller);
    try {
      const response = await timed("headers", () => fetcher(url, {
        method,
        headers,
        ...(body !== undefined ? { body: text } : {}),
        redirect: "error",
        ...(cacheMode ? { cache: cacheMode } : {}),
        signal: AbortSignal.any(signals),
      }));
      checkGeneration();
      if (
        response.redirected ||
        (response.url && new URL(response.url).origin !== base.origin)
      )
        throw failure("ACCOUNT_REDIRECT_REJECTED");
      if (grantRequest) {
        const details = { httpStatus: response.status };
        const requestId = response.headers.get("x-wanx-timing-id") || "";
        if (/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(requestId)) details.requestId = requestId;
        const duration = /^wanx_grant;dur=(\d+(?:\.\d+)?)$/.exec(response.headers.get("server-timing") || "");
        if (duration && Number.isFinite(Number(duration[1]))) details.serverDurationMs = Number(duration[1]);
        try { onGrantTiming(details); } catch {} // Diagnostics must not affect authorization.
      }
      const responseText = await timed("body", async () => {
        const reader = response.body?.getReader();
        if (!reader) return "";
        let size = 0;
        const chunks = [];
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 2 * 1024 * 1024)
              throw faqFeedbackRoute ? feedbackFailure(502) : failure("ACCOUNT_INVALID_RESPONSE");
            chunks.push(Buffer.from(value));
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        return Buffer.concat(chunks).toString("utf8");
      });
      if (acceptNotModified && response.status === 304) {
        checkGeneration();
        return { notModified: true, etag: response.headers.get("etag") || null };
      }
      let payload;
      const missingNetworkRoute =
        response.status === 404 && path.startsWith("/app-api/network/");
      const missingMarketRoute =
        response.status === 404 && path.startsWith("/app-api/market/");
      const upgradeRoute = path.startsWith("/app-api/v1/upgrades/");
      const supportRoute = /^\/app-api\/devices\/centauros-[0-9a-f]{24,32}\/(?:support-requests\/(?:current|[A-Za-z0-9_.-]+\/decision)|support-sessions\/[A-Za-z0-9_.-]+)$/.test(path);
      const missingUpgradeRoute = response.status === 404 && upgradeRoute;
      try {
        payload = JSON.parse(responseText);
      } catch {
        if (faqFeedbackRoute) throw feedbackFailure(response.ok ? 502 : response.status, undefined, { retryAfterSeconds: response.headers.get("retry-after") });
        if (faqRoute) throw response.ok ? failure("FAQ_INVALID_RESPONSE", 502) : faqFailure(response.status);
        if (creditRoute && response.status === 404)
          throw failure("CREDITS_SERVICE_UNAVAILABLE", 404);
        if (missingNetworkRoute)
          throw failure("NETWORK_SERVICE_NOT_DEPLOYED", 404);
        if (missingMarketRoute)
          throw failure("MARKET_SERVICE_NOT_DEPLOYED", 404);
        if (missingUpgradeRoute)
          throw failure("UPDATE_SERVICE_NOT_DEPLOYED", 404);
        throw failure(response.ok ? "ACCOUNT_INVALID_RESPONSE" : response.status === 401 ? "ACCOUNT_SESSION_EXPIRED" : response.status === 403 ? "ACCOUNT_ACCESS_DENIED" : "ACCOUNT_REQUEST_FAILED", response.ok ? undefined : response.status);
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        if (faqFeedbackRoute) throw feedbackFailure(response.ok ? 502 : response.status, undefined, { retryAfterSeconds: response.headers.get("retry-after") });
        if (faqRoute) throw response.ok ? failure("FAQ_INVALID_RESPONSE", 502) : faqFailure(response.status);
        if (missingNetworkRoute)
          throw failure("NETWORK_SERVICE_NOT_DEPLOYED", 404);
        if (missingMarketRoute)
          throw failure("MARKET_SERVICE_NOT_DEPLOYED", 404);
        if (missingUpgradeRoute)
          throw failure("UPDATE_SERVICE_NOT_DEPLOYED", 404);
        throw failure(response.ok ? "ACCOUNT_INVALID_RESPONSE" : response.status === 401 ? "ACCOUNT_SESSION_EXPIRED" : response.status === 403 ? "ACCOUNT_ACCESS_DENIED" : "ACCOUNT_REQUEST_FAILED", response.ok ? undefined : response.status);
      }
      checkGeneration();
      if (faqFeedbackRoute) {
        const status = response.status === 200 ? payload.code : response.status;
        if (!response.ok || payload.code !== 200 || payload.success !== true)
          throw feedbackFailure(status, payload.msg, { limitScope: payload.data?.limitScope,
            retryAfterSeconds: payload.data?.retryAfterSeconds ?? response.headers.get("retry-after") });
        if (payload.data?.received !== true || typeof payload.data.duplicate !== "boolean")
          throw feedbackFailure(502);
        return { received: true, duplicate: payload.data.duplicate };
      }
      const sessionReason = payload.errorCode || payload.data?.errorCode;
      if ((response.status === 401 || payload.code === 401) && terminalSessionReason(sessionReason))
        throw failure(sessionReason, 401);
      let metadata;
      if (creditRoute && response.status === 404 &&
          Object.keys(payload).length === 1 && payload.detail === "Not Found")
        throw failure("CREDITS_SERVICE_UNAVAILABLE", 404);
      if (creditRoute) return decodeCreditEnvelope(payload, response.status);
      if (responseMetadata) {
        if (response.status === 401 || payload.code === 401)
          throw failure("ACCOUNT_SESSION_EXPIRED", 401);
        const requestId =
          response.headers.get("x-request-id") ||
          response.headers.get("request-id");
        if (
          typeof requestId !== "string" ||
          !requestId ||
          requestId !== payload.requestId ||
          typeof payload.serverTime !== "string" ||
          !Number.isFinite(Date.parse(payload.serverTime))
        )
          throw failure("ACCOUNT_INVALID_RESPONSE");
        metadata = {
          requestId,
          serverTime: payload.serverTime,
          receivedMonotonicMs: Math.floor(performance.now()),
        };
      }
      if (
        !response.ok ||
        payload.success === false ||
        (typeof payload.code === "number" && payload.code !== 200 &&
          !(responseMetadata && payload.code === 0 && payload.success === true))
      ) {
        const status =
          response.status === 200 && typeof payload.code === "number"
            ? payload.code
            : response.status;
        if (faqRoute) throw faqFailure(status);
        // The old market contract rejects this new capability field. Recognize
        // only that exact validation error, without exposing arbitrary details
        // or treating other validation/authentication failures as compatibility.
        if (response.status === 422 && /^\/app-api\/market\/apps\/[a-z][a-z0-9._-]{1,63}\/candidate$/.test(path) &&
            Array.isArray(payload.detail) && payload.detail.length === 1 &&
            payload.detail[0]?.type === "extra_forbidden" &&
            JSON.stringify(payload.detail[0].loc) === '["body","supportsReleaseAccess"]')
          throw failure("MARKET_RELEASE_CAPABILITY_UNSUPPORTED", 422);
        // Never expose arbitrary server text, request bodies or token values.
        const remoteCode =
          payload.errorCode || payload.data?.errorCode || (supportRoute ? payload.detail?.errorCode || payload.msg?.errorCode : null) || payload.code;
        if (status === 426 && remoteCode === "CLIENT_UPDATE_REQUIRED") {
          void Promise.resolve().then(onClientUpdateRequired).catch(() => {});
          throw failure("CLIENT_UPDATE_REQUIRED", 426);
        }
        const explicitSupportCode = supportRoute && ["OWNER_REQUIRED", "OWNER_CHANGED", "DEVICE_NOT_FOUND", "DEVICE_DISABLED",
          "SUPPORT_REQUEST_NOT_FOUND", "REQUEST_DIGEST_MISMATCH", "REQUEST_EXPIRED", "DECISION_CONFLICT", "SUPPORT_NOT_ACTIVE",
          "SUPPORT_AUTHORIZATION_BUSY"].includes(remoteCode);
        const explicitConsoleClaimCode = path === "/app-api/device-console-claims/redeem" &&
          typeof remoteCode === "string" && /^(CONSOLE_CLAIM_[A-Z0-9_]{1,64}|OWNER_ALREADY_CHANGED|IDEMPOTENCY_CONFLICT)$/.test(remoteCode);
        const explicitNetworkCode =
          typeof remoteCode === "string" &&
          /^NETWORK_[A-Z0-9_]{1,64}$/.test(remoteCode);
        const explicitMarketCode =
          typeof remoteCode === "string" &&
          (/^MARKET_[A-Z0-9_]{1,64}$/.test(remoteCode) || remoteCode === "APPLICATION_RETIRED");
        const explicitUpgradeCode = upgradeRoute && [
          "PLAN_STALE", "UPDATE_IN_PROGRESS", "UNSUPPORTED_PLATFORM", "CONTRACT_UNSUPPORTED",
          "DEPENDENCY_CONFLICT", "UPDATE_PERMISSION_REQUIRED", "RELEASE_WITHDRAWN", "RECOVERY_REQUIRED",
          "INVENTORY_STALE", "INVENTORY_UNKNOWN", "SIGNATURE_INVALID", "IDEMPOTENCY_CONFLICT",
          "EVENT_SEQUENCE_INVALID", "RELEASE_UNAVAILABLE", "UPDATE_NOT_CONFIGURED",
          "CLIENT_UPDATE_REQUIRED",
        ].includes(remoteCode);
        const code =
          explicitConsoleClaimCode ? remoteCode
            : explicitSupportCode ? remoteCode
            : explicitUpgradeCode ? remoteCode
            : missingUpgradeRoute ? "UPDATE_SERVICE_NOT_DEPLOYED"
            : path === "/app-api/auth/sms/send" && payload.code === 602
            ? "SMS_DAILY_LIMIT"
            : missingNetworkRoute && !explicitNetworkCode
            ? "NETWORK_SERVICE_NOT_DEPLOYED"
            : missingMarketRoute && !explicitMarketCode
            ? "MARKET_SERVICE_NOT_DEPLOYED"
            : path.startsWith("/app-api/market/") && remoteCode === "APPLICATION_RETIRED"
            ? remoteCode
            : typeof remoteCode === "string" &&
              /^(NETWORK|SSO|OMNIA|MARKET|OWNERSHIP)_[A-Z0-9_]{1,64}$/.test(remoteCode)
            ? remoteCode
            : path.includes("/ownership/") && remoteCode === "SMS_CODE_INVALID"
            ? remoteCode
            : path.startsWith("/app-api/auth/") && ["AUTH_RATE_LIMITED", "PASSWORD_RESET_RATE_LIMITED", "SMS_RATE_LIMITED", "SMS_DAILY_LIMIT", "SMS_CODE_INVALID", "PASSWORD_ALREADY_SET", "PASSWORD_WEAK", "PASSWORD_INVALID", "PASSWORD_NOT_SET"].includes(remoteCode)
            ? remoteCode
            : status === 401
            ? "ACCOUNT_SESSION_EXPIRED"
            : status === 403
            ? "ACCOUNT_ACCESS_DENIED"
            : "ACCOUNT_REQUEST_FAILED";
        const pairingCode =
          responseMetadata &&
          typeof remoteCode === "string" &&
          /^[A-Z][A-Z0-9_]{1,79}$/.test(remoteCode)
            ? remoteCode
            : code;
        throw Object.assign(failure(pairingCode, status), metadata);
      }
      if (responseMetadata) {
        if (payload.success !== true || payload.errorCode != null)
          throw failure("ACCOUNT_INVALID_RESPONSE");
        return { data: payload.data, ...metadata };
      }
      if (exposeEtag) return { data: payload.data, etag: response.headers.get("etag") || null };
      return Object.hasOwn(payload, "data") ? payload.data : payload;
    } catch (error) {
      checkGeneration();
      if (error.status || error.code?.startsWith("ACCOUNT_")) throw error;
      throw failure(
        signal?.aborted ? "ACCOUNT_CANCELLED" : "ACCOUNT_NETWORK_ERROR",
      );
    } finally {
      pending.delete(controller);
    }
  }
  function sessionFrom(data, identity) {
    if (
      !data ||
      typeof data.accessToken !== "string" ||
      typeof data.refreshToken !== "string" ||
      typeof data.accountId !== "string" ||
      data.clientId !== identity.clientId ||
      !Number.isFinite(data.expiresIn) ||
      data.expiresIn <= 0
    )
      throw failure("ACCOUNT_INVALID_RESPONSE");
    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      accountId: data.accountId,
      clientId: data.clientId,
      expiresAt: now() + data.expiresIn * 1000,
    };
  }
  async function refresh() {
    if (refreshPromise) return refreshPromise;
    if (!record?.session) throw failure("ACCOUNT_LOGIN_REQUIRED");
    const generation = epoch,
      previous = record;
    refreshPromise = (async () => {
      const data = await measure("account.refresh.http", () => wire(
        {
          method: "POST",
          path: "/app-api/auth/refresh",
          body: { refreshToken: previous.session.refreshToken },
          authenticated: false,
        },
        generation,
      ));
      assert(generation);
      const session = sessionFrom(data, previous.identity);
      if (session.accountId !== previous.session.accountId)
        throw failure("ACCOUNT_INVALID_RESPONSE");
      const next = { ...previous, session };
      await measure("account.refresh.persist", () => persist(next));
      assert(generation);
      record = next;
      return snapshot();
    })();
    try {
      return await refreshPromise;
    } catch (error) {
      if (terminalSessionReason(error.code)) {
        await endReplacedSession(error.code, generation);
        throw error;
      }
      if (
        generation === epoch &&
        (error.status === 401 || error.status === 403)
      ) {
        record = null;
        publish({
          phase: "signed_out",
          accountId: null,
          clientId: null,
          devices: [],
          reason: "ACCOUNT_SESSION_EXPIRED",
        });
        await persist(null);
      }
      throw error;
    } finally {
      if (generation === epoch) refreshPromise = null;
    }
  }
  function measureCreditRequest(input, operation) {
    const path = input?.path || '';
    if (!path.startsWith('/app-api/v1/credits/')) return operation();
    let step = 'credit.payment.status';
    if (input.method === 'POST' && path === '/app-api/v1/credits/orders') step = 'credit.payment.create';
    else if (input.method === 'POST' && /\/orders\/[^/]+\/close$/.test(path)) step = 'credit.payment.close';
    else if (path.endsWith('/catalog') || path.endsWith('/catalog/v2')) step = 'credit.checkout.catalog';
    return measure(step, operation);
  }

  async function request(input) {
    const generation = epoch;
    if (!record?.session) throw failure("ACCOUNT_LOGIN_REQUIRED");
    const grantRequest = isGrantRequest(input);
    const renew = () => grantRequest ? measure("account.grant.refresh", () => refresh()) : refresh();
    const send = async () => {
      try {
        return await measureCreditRequest(input, () => wire({ ...input, authenticated: true }, generation));
      } catch (error) {
        if (terminalSessionReason(error.code)) await endReplacedSession(error.code, generation);
        throw error;
      }
    };
    if (record.session.expiresAt <= now() + 30000) await renew();
    assert(generation);
    try {
      return await send();
    } catch (error) {
      if (error.status !== 401 || terminalSessionReason(error.code)) throw error;
      await renew();
      assert(generation);
      return grantRequest ? measure("account.grant.retry", send) : send();
    }
  }
  async function login(input, mode) {
    if (
      !/^1\d{10}$/.test(input?.phone || "") ||
      (mode === "sms"
        ? !/^\d{6}$/.test(input.code || "")
        : typeof input.password !== "string" ||
          !input.password ||
          Buffer.byteLength(input.password) > 72)
    )
      throw failure("ACCOUNT_INVALID_INPUT");
    if (mode === "register" && (
      !/^\d{6}$/.test(input.code || "") ||
      Buffer.byteLength(input.password, "utf8") < 8 || /[\r\n\0]/.test(input.password)
    )) throw failure("ACCOUNT_INVALID_INPUT");
    if (closed) throw failure("ACCOUNT_CANCELLED");
    if (record?.session) throw failure("ACCOUNT_ALREADY_SIGNED_IN");
    // Logout revokes every server session for this client. Never let its late
    // response invalidate a freshly issued session for the same identity.
    const beforeCleanup = epoch;
    await measure("account.login.cleanup", async () => {
      await logoutCleanup;
      await passwordUpdate?.catch(() => {});
    });
    assert(beforeCleanup);
    cancel();
    const generation = epoch;
    publish({ phase: "authenticating", reason: null });
    try {
      const identity = await measure("account.login.local", async () => {
        await writes;
        assert(generation);
        await loadVault(generation);
        const value = vault.accounts[input.phone]?.identity || newIdentity();
        if (!vault.accounts[input.phone] || vault.signedOutReason) {
          await persist({ phone: input.phone, identity: value, session: null }, { signedOutReason: null });
          assert(generation);
        }
        return value;
      });
      const data = await measure("account.login.request", () => wire(
        {
          method: "POST",
          path: mode === "register" ? "/app-api/auth/password/register" : `/app-api/auth/${mode}/login`,
          authenticated: false,
          body: {
            phone: input.phone,
            ...(mode === "sms"
              ? { code: input.code }
              : { password: input.password }),
            ...(mode === "register" ? { code: input.code } : {}),
            clientId: identity.clientId,
            clientPublicKey: identity.publicKey,
            platform:
              { darwin: "macos", win32: "windows" }[platform] ||
              (["linux", "macos", "windows"].includes(platform)
                ? platform
                : "unknown"),
            deviceModel,
            displayName: "万象连接",
          },
        },
        generation,
      ));
      const next = {
        phone: input.phone,
        identity,
        session: sessionFrom(data, identity),
      };
      await measure("account.login.persist", () => persist(next, mode === "password" ? {
        rememberedLogin: input.remember === true
          ? { remember: true, phone: input.phone, password: input.password }
          : { remember: false },
      } : {}));
      assert(generation);
      record = next;
      return publish({
        phase: "authenticated",
        accountId: next.session.accountId,
        clientId: identity.clientId,
        devices: [],
        reason: null,
      });
    } catch (error) {
      if (generation === epoch)
        publish({
          phase: "signed_out",
          accountId: null,
          clientId: null,
          devices: [],
          reason: error.code || error.message,
        });
      throw error;
    }
  }
  function requirePasswordMode(authenticated) {
    if (closed) throw failure("ACCOUNT_CANCELLED");
    if (authenticated) {
      if (!record?.session || state.phase !== "authenticated") throw failure("ACCOUNT_LOGIN_REQUIRED");
    } else if (record?.session || state.phase !== "signed_out") {
      throw failure("ACCOUNT_ALREADY_SIGNED_IN");
    }
  }
  async function sendPasswordCode(phone, authenticated) {
    requirePasswordMode(authenticated);
    const number = authenticated ? record.phone : phone;
    if (typeof number !== "string" || !/^1\d{10}$/.test(number)) throw failure("ACCOUNT_INVALID_INPUT");
    const result = await wire({ method: "POST", path: "/app-api/auth/sms/send",
      body: { phone: number, scene: "consumer_reset_password" }, authenticated: false }, epoch);
    return { expiresIn: Number(result?.expiresIn) || 300 };
  }
  async function updatePassword(input, authenticated) {
    requirePasswordMode(authenticated);
    const phone = authenticated ? record.phone : input?.phone;
    if (typeof phone !== "string" || !/^1\d{10}$/.test(phone) || typeof input?.code !== "string" || !/^\d{6}$/.test(input.code) ||
        typeof input?.password !== "string" || Buffer.byteLength(input.password, "utf8") < 8 ||
        Buffer.byteLength(input.password, "utf8") > 72 || /[\r\n\0]/.test(input.password))
      throw failure("ACCOUNT_INVALID_INPUT");
    if (passwordUpdate) throw failure("ACCOUNT_REQUEST_IN_PROGRESS");
    const generation = epoch;
    // Password reset revokes every account session. Drain this request before
    // issuing a new login, even if the user signs out while it is in flight.
    const update = (async () => {
      await loadVault(generation);
      await wire({ method: "POST", path: "/app-api/auth/password/reset",
        body: { phone, code: input.code, password: input.password }, authenticated: false }, generation, null, true);
      const rememberedPatch = vault.rememberedLogin?.phone === phone
        ? { rememberedLogin: { remember: true } } : {};
      if (authenticated && !closed && generation === epoch) {
        cancel();
        record = null;
        const cleared = persist(null, rememberedPatch);
        publish({ phase: "signed_out", accountId: null, clientId: null, devices: [],
          reason: "password_reset", logoutPending: false });
        await cleared;
      } else if (!closed && generation === epoch && rememberedPatch.rememberedLogin) {
        await persist(record, rememberedPatch);
      }
      return { passwordReset: true };
    })();
    passwordUpdate = update;
    try { return await update; }
    finally { if (passwordUpdate === update) passwordUpdate = null; }
  }
  async function saveProfile(input) {
    const patch = validateProfilePatch(input);
    if (state.phase !== "authenticated" || !record?.session) throw failure("ACCOUNT_LOGIN_REQUIRED");
    const generation = epoch, accountId = record.session.accountId;
    const operation = writes.then(async () => {
      assert(generation);
      if (record?.session?.accountId !== accountId) throw failure("ACCOUNT_CANCELLED");
      const nextProfile = { ...publicProfile(vault.profiles?.[accountId]), ...patch };
      const candidate = { ...vault, profiles: { ...vault.profiles, [accountId]: nextProfile } };
      await store.save(candidate);
      vault = candidate;
      assert(generation);
      publish({});
      return publicProfile(nextProfile);
    });
    writes = operation.catch(() => {});
    return operation;
  }
  return {
    snapshot,
    // A retry retains the submitted body/key only in this account module's memory.
    async feedback(input) {
      const body = feedbackBody(input), fingerprint = hash(JSON.stringify(body));
      if (feedbackPending) {
        if (feedbackSubmission?.fingerprint !== fingerprint) throw feedbackFailure(400);
        return feedbackPending;
      }
      if (feedbackSubmission?.fingerprint !== fingerprint)
        feedbackSubmission = { key: randomUUID(), fingerprint };
      const submission = feedbackSubmission;
      const task = wire({ path: "/app-api/faq/feedback", method: "POST", body,
        authenticated: false, idempotencyKey: submission.key, clientContext: true }, epoch)
        .then(value => { if (feedbackSubmission === submission) feedbackSubmission = null; return value; }, error => {
          if (feedbackSubmission === submission && ["FAQ_FEEDBACK_IDEMPOTENCY_CONFLICT", "FAQ_FEEDBACK_INVALID_CONTENT"].includes(error.code))
            feedbackSubmission = null;
          throw error;
        }).finally(() => { if (feedbackPending === task) feedbackPending = null; });
      feedbackPending = task;
      return task;
    },
    // Public read only: never load the vault, refresh a token or require a box.
    async faq(input = {}) {
      if (!input || typeof input !== "object" || Array.isArray(input) ||
          Object.keys(input).some(key => key !== "etag") ||
          (input.etag != null && (typeof input.etag !== "string" ||
            !/^(?:W\/)?"[\x21\x23-\x7e]{1,160}"$/.test(input.etag))))
        throw failure("ACCOUNT_INVALID_INPUT");
      const result = await wire({ path: "/app-api/faq", authenticated: false,
        ifNoneMatch: input.etag, acceptNotModified: Boolean(input.etag),
        exposeEtag: true, cacheMode: "no-cache" }, epoch);
      if (result.notModified) return result;
      const data = result.data;
      const validId = value => Number.isSafeInteger(value) && value > 0 ||
        typeof value === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(value);
      if (!data || typeof data !== "object" ||
          typeof data.version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(data.version) ||
          !(data.updatedAt === null || typeof data.updatedAt === "string" && Number.isFinite(Date.parse(data.updatedAt))) ||
          !Array.isArray(data.categories) || data.categories.some(category =>
            !category || !validId(category.id) || typeof category.name !== "string" ||
            !Array.isArray(category.items) || category.items.some(item =>
              !item || !validId(item.id) || typeof item.question !== "string" || typeof item.answer !== "string")))
        throw failure("FAQ_INVALID_RESPONSE", 502);
      return { data, etag: result.etag || `W/"${data.version}"` };
    },
    request,
    refresh,
    saveProfile,
    async chooseAvatar(choose) {
      const generation = epoch;
      if (state.phase !== "authenticated") throw failure("ACCOUNT_LOGIN_REQUIRED");
      const avatar = await choose();
      assert(generation);
      return avatar == null ? { canceled: true } : saveProfile({ avatarDataUrl: avatar });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // Main-only read transport. The renderer never receives or supplies credentials/URLs.
    async creditsRequest({ serviceURL, path }) {
      const target = new URL(serviceURL);
      if ((target.protocol !== "https:" && !(target.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(target.hostname))) ||
          target.username || target.password || target.pathname !== "/" || target.search || target.hash ||
          !(/^\/api\/credits\/(balance|tasks|tasks\/[A-Za-z0-9_-]{1,128}|meter-session\?application_id=[A-Za-z0-9._-]{1,128}|transactions\?after=\d+&limit=50|reservations\/[A-Za-z0-9_-]{1,128})$/.test(path)))
        throw failure("CREDITS_NOT_CONFIGURED");
      const generation = epoch;
      if (!record?.session) throw failure("ACCOUNT_LOGIN_REQUIRED");
      if (record.session.expiresAt <= now() + 30000) await refresh();
      for (let attempt = 0; attempt < 2; attempt++) {
        assert(generation);
        const auth = record;
        const controller = new AbortController(); pending.add(controller);
        try {
          const proof = consumerSignature({ identity: auth.identity, accountId: auth.session.accountId,
            method: "GET", path: "/app-api/v1/sync/bootstrap", now: now() });
          const response = await fetcher(new URL(path.replace("/credits/", "/credits/account/"), target).href, {
            method: "GET", redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
            headers: { ...proof, Authorization: `Bearer ${auth.session.accessToken}`, Accept: "application/json" },
          });
          assert(generation);
          if (response.redirected || (response.url && new URL(response.url).origin !== target.origin))
            throw failure("CREDITS_UNAVAILABLE");
          const chunks = []; let size = 0;
          const reader = response.body.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read(); if (done) break;
              size += value.length; if (size > 2 * 1024 * 1024) throw failure("CREDITS_INVALID_RESPONSE");
              chunks.push(Buffer.from(value));
            }
          } finally { await reader.cancel().catch(() => {}); }
          assert(generation);
          const body = Buffer.concat(chunks);
          let envelope;
          try { envelope = JSON.parse(body); } catch {} // Legacy non-JSON responses keep their existing handling.
          const sessionReason = envelope?.errorCode || envelope?.data?.errorCode;
          if ((response.status === 401 || envelope?.code === 401) && terminalSessionReason(sessionReason)) {
            await endReplacedSession(sessionReason, generation);
            throw failure(sessionReason, 401);
          }
          if (attempt === 0 && [401, 403].includes(response.status)) { await refresh(); continue; }
          if (response.status === 200 && path === "/api/credits/balance") {
            let result; try { result = JSON.parse(body); } catch { throw failure("CREDITS_INVALID_RESPONSE"); }
            if (result.account_id !== auth.session.accountId) throw failure("ACCOUNT_SESSION_CHANGED");
          }
          return { status: response.status, body };
        } finally { pending.delete(controller); }
      }
    },
    getIdentity: () =>
      record?.session
        ? {
            accountId: record.session.accountId,
            clientId: record.identity.clientId,
          }
        : null,
    loginPassword: (input) => login(input, "password"),
    async getRememberedLogin() {
      const generation = epoch;
      await writes;
      await loadVault(generation);
      assert(generation);
      const saved = vault.rememberedLogin;
      return saved?.remember === true
        ? { remember: true, phone: saved.phone, password: saved.password }
        : { remember: saved?.remember !== false };
    },
    async forgetRememberedLogin() {
      const generation = epoch;
      await writes;
      await loadVault(generation);
      assert(generation);
      await persist(record, { rememberedLogin: { remember: false } });
    },
    loginSMS: (input) => login(input, "sms"),
    register: (input) => login(input, "register"),
    sendResetCode: (input) => sendPasswordCode(input?.phone, false),
    resetPassword: (input) => updatePassword(input, false),
    sendChangeCode: () => sendPasswordCode(null, true),
    changePassword: (input) => updatePassword(input, true),
    async sendSMS(phone, scene = "consumer_login") {
      if (!/^1\d{10}$/.test(phone || "") || !["consumer_login", "consumer_register"].includes(scene))
        throw failure("ACCOUNT_INVALID_INPUT");
      const result = await wire(
        {
          method: "POST",
          path: "/app-api/auth/sms/send",
          body: { phone, scene },
          authenticated: false,
        },
        epoch,
      );
      return { expiresIn: Number(result?.expiresIn) || 300 };
    },
    async redeemConsoleClaim({ claimCode, clientAttemptId, expectedDeviceId, signal } = {}) {
      if (!record?.session) throw failure("ACCOUNT_LOGIN_REQUIRED");
      if (typeof claimCode !== "string" || !/^(?:[A-Z2-7]{10}|[A-Z2-7]{20})$/.test(claimCode) ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientAttemptId || "") ||
          (expectedDeviceId !== undefined && !claimDeviceId(expectedDeviceId)))
        throw failure("ACCOUNT_INVALID_INPUT");
      signal?.throwIfAborted();
      const data = await request({ method: "POST", path: "/app-api/device-console-claims/redeem",
        body: { claimCode, clientAttemptId, ...(expectedDeviceId === undefined ? {} : { expectedDeviceId }) },
        idempotencyKey: clientAttemptId, signal });
      signal?.throwIfAborted();
      if (!claimDeviceId(data?.deviceId) || data.ownership !== "claimed" ||
          (expectedDeviceId !== undefined && data.deviceId !== expectedDeviceId) ||
          (data.authorizationState !== undefined && !["deviceAckPending", "ready", "blocked"].includes(data.authorizationState)))
        throw failure("ACCOUNT_INVALID_RESPONSE");
      return { deviceId: data.deviceId, ownership: data.ownership,
        authorizationState: data.authorizationState ?? "deviceAckPending" };
    },
    async getConsoleClaimAuthorization(deviceId, signal) {
      if (!record?.session) throw failure("ACCOUNT_LOGIN_REQUIRED");
      if (!claimDeviceId(deviceId)) throw failure("ACCOUNT_INVALID_INPUT");
      const generation = epoch, accountId = record.session.accountId, clientId = record.identity.clientId;
      signal?.throwIfAborted();
      const result = await request({ path: "/app-api/v1/sync/bootstrap", signal, responseMetadata: true });
      assert(generation);
      signal?.throwIfAborted();
      const data = result.data, currentClient = data?.account?.currentClient;
      if (data?.account?.accountId !== accountId || currentClient?.clientId !== clientId ||
          currentClient.isCurrent !== true || data.account.accountStatus !== "active" ||
          currentClient.clientStatus !== "active" || currentClient.hasActiveSession !== true || !Array.isArray(data.devices))
        throw failure("ACCOUNT_INVALID_RESPONSE");
      const matching = data.devices.filter(device => device?.deviceId === deviceId);
      if (matching.length > 1) throw failure("ACCOUNT_INVALID_RESPONSE");
      const device = matching[0];
      let authorizationState = "deviceAckPending";
      if (device?.accessStatus === "blocked" || ["disabled", "quarantined"].includes(device?.securityStatus) ||
          device?.ownershipStatus === "releasePending") authorizationState = "blocked";
      else if (device?.accessStatus === "ready" && device.ownershipStatus === "active" &&
          device.securityStatus === "normal" && device.capabilities?.canConnect?.enabled === true) authorizationState = "ready";
      return { deviceId, authorizationState };
    },
    async listOwnershipTransfers() {
      const data = await request({ path: "/app-api/ownership/transfers" });
      if (!Array.isArray(data)) throw failure("ACCOUNT_INVALID_RESPONSE");
      return data.map(transferView);
    },
    async sendTransferCode() {
      if (!record?.session) throw failure("ACCOUNT_LOGIN_REQUIRED");
      return wire({ method: "POST", path: "/app-api/auth/sms/send",
        body: { phone: record.phone, scene: "consumer_login" }, authenticated: false }, epoch).then(() => ({ expiresIn: 300 }));
    },
    async createOwnershipTransfer({ deviceId, targetPhone, verificationCode, retainData } = {}) {
      if (!record?.session) throw failure("ACCOUNT_LOGIN_REQUIRED");
      if (!ownershipId(deviceId) || !/^1\d{10}$/.test(targetPhone || "") ||
          !/^\d{6}$/.test(verificationCode || "") || retainData !== true)
        throw failure("ACCOUNT_INVALID_INPUT");
      if (targetPhone === record.phone) throw failure("OWNERSHIP_TARGET_SELF");
      const generation = epoch, ownerPhone = record.phone;
      const owned = await request({ path: "/app-api/devices" });
      assert(generation);
      if (!Array.isArray(owned)) throw failure("ACCOUNT_INVALID_RESPONSE");
      if (!owned.some(item => item.deviceId === deviceId && item.role === "owner" && item.status === "active"))
        throw failure("OWNERSHIP_OWNER_REQUIRED");
      const value = transferView(await request({ method: "POST",
        path: `/app-api/devices/${deviceId}/ownership/transfer`,
        body: { ownerPhone, verificationCode, targetPhone, retainData: true } }));
      assert(generation);
      if (value.deviceId !== deviceId || value.direction !== "outgoing" || !value.retainData)
        throw failure("ACCOUNT_INVALID_RESPONSE");
      return value;
    },
    async acceptOwnershipTransfer({ transferId, retainData } = {}) {
      if (!ownershipId(transferId) || retainData !== true) throw failure("ACCOUNT_INVALID_INPUT");
      const generation = epoch;
      const data = await request({ path: "/app-api/ownership/transfers" });
      assert(generation);
      if (!Array.isArray(data)) throw failure("ACCOUNT_INVALID_RESPONSE");
      const transfer = data.map(transferView).find(item => item.transferId === transferId);
      if (!transfer || transfer.direction !== "incoming" || transfer.state !== "pending_target" ||
          !transfer.retainData || Date.parse(transfer.expiresAt) <= now()) throw failure("OWNERSHIP_TRANSFER_UNAVAILABLE");
      const value = transferView(await request({ method: "POST", path: `/app-api/ownership/transfers/${transferId}/accept` }));
      assert(generation);
      if (value.transferId !== transferId || value.deviceId !== transfer.deviceId || value.direction !== "incoming" ||
          value.state !== "completed" || !value.retainData) throw failure("ACCOUNT_INVALID_RESPONSE");
      return value;
    },
    async listDevices() {
      const generation = epoch;
      const data = await request({ path: "/app-api/devices" });
      assert(generation);
      if (!Array.isArray(data)) throw failure("ACCOUNT_INVALID_RESPONSE");
      const devices = data
        .filter((item) => typeof item.deviceId === "string")
        .map((item) => ({
          deviceId: item.deviceId,
          deviceName:
            typeof item.deviceName === "string"
              ? item.deviceName
              : item.deviceId,
          online: item.online === true,
          ownershipEpoch: item.ownershipEpoch,
          role: item.role,
          status: item.status,
        }));
      publish({ devices });
      return structuredClone(devices);
    },
    async lookupDeviceDiscovery(deviceIds) {
      if (!Array.isArray(deviceIds) || deviceIds.length < 1 || deviceIds.length > 16 ||
          deviceIds.some(id => typeof id !== "string" || !/^centauros-(?:[0-9a-f]{24}|[0-9a-f]{32})$/.test(id)) ||
          new Set(deviceIds).size !== deviceIds.length) throw failure("ACCOUNT_INVALID_INPUT");
      const ids = [...deviceIds];
      const data = await request({ path: `/app-api/v1/device-discovery?ids=${encode(ids.join(","))}` });
      if (!Array.isArray(data?.devices) || data.devices.length !== ids.length)
        throw failure("ACCOUNT_INVALID_RESPONSE");
      const devices = new Map();
      for (const item of data.devices) {
        if (!item || !ids.includes(item.deviceId) || devices.has(item.deviceId) ||
            !["claimed", "unclaimed", "unknown"].includes(item.claimStatus) ||
            (item.deviceName !== null && (typeof item.deviceName !== "string" ||
              !item.deviceName.trim() || item.deviceName.length > 128 ||
              /[\u0000-\u001f\u007f-\u009f]/u.test(item.deviceName))))
          throw failure("ACCOUNT_INVALID_RESPONSE");
        devices.set(item.deviceId, { deviceId: item.deviceId,
          deviceName: item.deviceName?.trim() || null, claimStatus: item.claimStatus });
      }
      return { devices: ids.map(id => devices.get(id)) };
    },
    async lookupDeviceName(deviceId) {
      if (typeof deviceId !== "string" || !/^centauros-[0-9a-f]{24,32}$/.test(deviceId))
        throw failure("ACCOUNT_INVALID_INPUT");
      const data = await request({ path: `/app-api/v1/device-names?ids=${encode(deviceId)}` });
      if (!Array.isArray(data?.names) || data.names.length > 1) throw failure("ACCOUNT_INVALID_RESPONSE");
      const item = data.names[0];
      if (!item) return null;
      if (item.deviceId !== deviceId || typeof item.deviceName !== "string" ||
        !item.deviceName.trim() || item.deviceName.length > 128 ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(item.deviceName)) throw failure("ACCOUNT_INVALID_RESPONSE");
      return item.deviceName.trim();
    },
    async restore() {
      const generation = epoch;
      await loadVault(generation);
      const active = vault.active;
      if (!active) return terminalSessionReason(vault.signedOutReason)
        ? publish({ reason: vault.signedOutReason }) : snapshot();
      const identity = vault.accounts[active.phone]?.identity;
      if (
        !identity?.privateKey ||
        !active.session?.refreshToken ||
        identity.clientId !== active.session.clientId
      )
        throw failure("ACCOUNT_INVALID_STORED_SESSION");
      record = { phone: active.phone, identity, session: active.session };
      publish({ phase: "authenticating", reason: null });
      try {
        await refresh();
        assert(generation);
        return publish({
          phase: "authenticated",
          accountId: record.session.accountId,
          clientId: record.identity.clientId,
          reason: null,
        });
      } catch (error) {
        if (generation === epoch) {
          record = null;
          publish({ phase: "signed_out", reason: error.code });
          if (error.status === 401 || error.status === 403) await persist(null);
        }
        throw error;
      }
    },
    async logout() {
      const previous = record;
      cancel();
      const generation = epoch;
      record = null;
      // Clear durable credentials before waiting for any remote operation.
      // Remote cleanup is isolated from ordinary cancellation and holds only
      // the old credentials; new logins wait for it before issuing requests.
      const cleared = persist(null, { signedOutReason: null });
      if (previous?.session) {
        // Auth logout advances the server client-session version, invalidating
        // its network enrollment too. The server reconciler removes old peers;
        // waiting for network/current here would block account login on P2P.
        const cleanup = wire({ method: "POST", path: "/app-api/auth/logout",
          body: { refreshToken: previous.session.refreshToken } }, generation, previous, true)
          .catch(() => {}).then(() => {
          if (!closed && logoutCleanup === cleanup) publish({ logoutPending: false });
        });
        logoutCleanup = cleanup;
      }
      publish({
        phase: "signed_out",
        accountId: null,
        clientId: null,
        devices: [],
        reason: null,
        logoutPending: Boolean(previous?.session) || state.logoutPending,
      });
      await cleared;
      return snapshot();
    },
    async close() {
      closed = true;
      cancel();
      record = null;
      await Promise.all([writes, logoutCleanup, passwordUpdate?.catch(() => {})]);
    },
  };
}
