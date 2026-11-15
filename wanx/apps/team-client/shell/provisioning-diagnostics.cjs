"use strict";

const messageTypes = new Set(["wifi.apply.result", "job.status.result"]);
const deviceErrors = new Set([
  "auth_failed", "ssid_not_found", "dhcp_failed", "dns_failed", "internet_unreachable",
  "unsupported_network_security", "networkmanager_unavailable", "wifi_connection_failed", "protocol_error",
  "session_expired", "OWNER_AUTHORIZATION_SYNC_PENDING", "LOCAL_WIFI_REQUIRED", "LOCAL_WIFI_UNAUTHORIZED",
  "OWNER_WIFI_AUTHORIZATION_REQUIRED", "CONSOLE_WIFI_AUTHORIZATION_REQUIRED",
]);
const flowStates = new Set([
  "idle", "connecting", "readingDeviceInfo", "previewReady", "verifyingLocalDevice", "localDeviceVerified",
  "establishingSecureChannel", "awaitingWifi", "awaitingOwnershipConfirmation", "awaitingCodeClaim",
  "submittingAppProof", "provisioningWifi", "waitingCloud", "attentionRequired", "completed",
  "recoverableError", "terminalError", "cancelling", "cancelled", "suspended", "restartRequired",
]);
const flowErrors = new Set([
  "PROTOCOL_CHANGED", "DEVICE_OFFLINE", "WIFI_SCAN_FAILED", "WIFI_SCAN_TIMEOUT", "WIFI_UNAVAILABLE",
  "UNSUPPORTED_NETWORK_SECURITY", "PAIRING_EXPIRED", "PAIRING_MISMATCH", "DEVICE_IDENTITY_MISMATCH",
  "OWNER_AUTHORIZATION_SYNC_PENDING", "HELLO_CONTEXT_EXPIRED", "REQUESTED_OPS_MISMATCH",
  "LOCAL_CONNECT_TIMEOUT", "LOCAL_TRANSPORT_DISCONNECTED", "GATT_FRAGMENT_INCOMPLETE",
  "GATT_FRAGMENT_PROTOCOL_ERROR", "CLAIM_UNKNOWN_ERROR", "ACCOUNT_SERVICE_UNAVAILABLE", "REQUEST_TIMEOUT",
]);

// Both producers and the disk recorder apply this closed projection. Even an
// authenticated peer or a coordinator must not choose arbitrary log strings.
function sanitizeProvisioningDiagnostic(value) {
  if (value?.kind === "flow" && flowStates.has(value.state)) {
    return { kind: "flow", outcome: "changed", state: value.state,
      ...(value.errorCode ? { errorCode: flowErrors.has(value.errorCode) ? value.errorCode : "UNKNOWN_ERROR" } : {}),
      ...(typeof value.retryable === "boolean" ? { retryable: value.retryable } : {}) };
  }
  if (value?.kind !== "protocol" || !messageTypes.has(value.messageType) ||
      !["authenticated", "decrypt_failed"].includes(value.outcome)) return;
  const result = { kind: "protocol", outcome: value.outcome, messageType: value.messageType };
  if (value.outcome === "authenticated") {
    result.responseStatus = ["completed", "failed"].includes(value.responseStatus) ? value.responseStatus : "invalid";
    if (result.responseStatus === "failed")
      result.deviceErrorCode = deviceErrors.has(value.deviceErrorCode) ? value.deviceErrorCode : "UNKNOWN_ERROR";
  }
  return result;
}

function createProvisioningDiagnostics(report) {
  let previousState;
  const emit = value => {
    try { const safe = sanitizeProvisioningDiagnostic(value); if (safe) Promise.resolve(report(safe)).catch(() => {}); }
    catch { /* Diagnostics cannot change provisioning or expose raw errors. */ }
  };
  return {
    state(value) {
      const safe = sanitizeProvisioningDiagnostic({ ...value, kind: "flow" });
      const next = JSON.stringify(safe);
      if (!safe || next === previousState) return;
      previousState = next;
      emit(safe);
    },
    crypto(provider) {
      if (typeof provider.aes256GcmDecrypt !== "function") return provider;
      return Object.freeze({ ...provider,
        async aes256GcmDecrypt(...args) {
          let messageType;
          try {
            const fields = new TextDecoder("utf-8", { fatal: true }).decode(args[2]).split("\n");
            if (fields.length === 7 && fields[0] === "NEXUSAOS-PROVISIONING-V2" && fields[3] === "device-to-app" &&
                messageTypes.has(fields[5])) messageType = fields[5];
          } catch { /* The original provider remains responsible for validation. */ }
          let clear;
          try { clear = await provider.aes256GcmDecrypt(...args); }
          catch (error) {
            if (messageType) emit({ kind: "protocol", outcome: "decrypt_failed", messageType });
            throw error;
          }
          if (messageType) {
            // AEAD authenticated these bytes; the SDK still owns all subsequent
            // envelope/payload validation. Return its original bytes untouched.
            let body;
            try {
              if (clear.byteLength <= 2048) body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(clear));
            } catch { /* A malformed body must still reach the SDK unchanged. */ }
            emit({ kind: "protocol", outcome: "authenticated", messageType,
              responseStatus: body?.status, deviceErrorCode: body?.error?.code });
          }
          return clear;
        },
      });
    },
  };
}

module.exports = { createProvisioningDiagnostics, sanitizeProvisioningDiagnostic };
