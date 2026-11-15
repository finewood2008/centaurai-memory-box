/**
 * Auth gate — wraps the whole app shell.
 *
 * State machine (`GET /api/v1/auth/status`):
 *
 *   needsSetup = true                  → <SetupScreen>
 *   needsSetup = false, !authenticated → <LoginScreen>
 *   authenticated = true               → render children
 *
 * First-run flow is mandatory password setup: there is no way to
 * skip the SetupScreen. Subsequent visits re-use the `memos_sess`
 * cookie until it expires (7 days). When the cookie expires the
 * user lands on the LoginScreen again.
 *
 */
import { useEffect, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { Icon } from "./Icon";
import { t } from "../stores/i18n";
import centaurMarkUrl from "../../../../App/frontend/desktop/src/assets/brand/centaurai-mark.png";

type Status =
  | { state: "loading" }
  | { state: "setup" }
  | { state: "login" }
  | { state: "ready" };

export function AuthGate({ children }: { children: ComponentChildren }) {
  const [status, setStatus] = useState<Status>({ state: "loading" });

  const refresh = async () => {
    try {
      const r = await fetch("/api/v1/auth/status", {
        cache: "no-store",
        headers: { "x-memmy-viewer": "1" },
      });
      if (r.status === 401) {
        setStatus({ state: "login" });
        return;
      }
      const body = (await r.json()) as {
        enabled?: boolean;
        needsSetup?: boolean;
        authenticated?: boolean;
      };
      if (body.needsSetup) setStatus({ state: "setup" });
      else if (body.enabled && !body.authenticated) setStatus({ state: "login" });
      else setStatus({ state: "ready" });
    } catch {
      setStatus({ state: "ready" });
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  if (status.state === "loading") {
    return (
      <div
        style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:var(--bg)"
      >
        <Icon name="loader-2" size={32} class="spin" />
      </div>
    );
  }

  if (status.state === "setup") return <SetupScreen onDone={refresh} />;
  if (status.state === "login") return <LoginScreen onUnlocked={refresh} />;
  return <>{children}</>;
}

// ─── Setup (first run) ──────────────────────────────────────────────────

function SetupScreen({ onDone }: { onDone: () => void }) {
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e?: Event) => {
    if (e) e.preventDefault();
    if (busy) return;
    setError(null);
    if (!pw1) {
      setError(t("auth.err.empty"));
      return;
    }
    if (pw1 !== pw2) {
      setError(t("auth.err.mismatch"));
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/v1/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw1 }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
        setError(body.error?.message ?? "setup failed");
        return;
      }
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell>
      <AuthLogo />
      <AuthHeader
        title={t("auth.setup.title")}
        subtitle={t("auth.setup.subtitle")}
      />
      <form onSubmit={submit} class="vstack" style="gap:var(--sp-4);width:100%">
        <AuthField
          label={t("auth.setup.newPassword")}
          type="password"
          value={pw1}
          autoFocus
          onInput={setPw1}
        />
        <AuthField
          label={t("auth.setup.confirm")}
          type="password"
          value={pw2}
          onInput={setPw2}
        />
        {error && <AuthError text={error} />}
        <button
          type="submit"
          class="memos-auth-submit"
          disabled={busy || !pw1 || !pw2}
        >
          <Icon name={busy ? "loader-2" : "check"} size={14} class={busy ? "spin" : ""} />
          {busy ? t("common.loading") : t("auth.setup.submit")}
        </button>
        <p
          style="font-size:12px;text-align:center;margin:0;color:hsl(0,0%,45.1%)"
        >
          {t("auth.setup.hint")}
        </p>
      </form>
    </AuthShell>
  );
}

// ─── Login (returning user / expired cookie) ────────────────────────────

function LoginScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e?: Event) => {
    if (e) e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (r.status === 200) {
        onUnlocked();
        return;
      }
      const body = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
      setError(body.error?.message ?? t("auth.err.badPassword"));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell>
      <AuthLogo />
      <AuthHeader
        title={t("auth.login.title")}
        subtitle={t("auth.login.subtitle")}
      />
      <form onSubmit={submit} class="vstack" style="gap:var(--sp-4);width:100%">
        <AuthField
          label={t("auth.login.password")}
          type="password"
          value={password}
          autoFocus
          onInput={setPassword}
        />
        {error && <AuthError text={error} />}
        <button
          type="submit"
          class="memos-auth-submit"
          disabled={busy || !password}
        >
          <Icon name={busy ? "loader-2" : "check"} size={14} class={busy ? "spin" : ""} />
          {busy ? t("common.loading") : t("auth.login.submit")}
        </button>
      </form>
    </AuthShell>
  );
}

// ─── Shell + atoms ──────────────────────────────────────────────────────

function AuthShell({ children }: { children: ComponentChildren }) {
  return (
    <div class="viewer-auth">
      <section class="viewer-auth__card">{children}</section>
    </div>
  );
}

function AuthLogo() {
  return (
    <div class="viewer-auth__brand">
      <img src={centaurMarkUrl} alt="" width={62} height={62} />
      <strong>{t("header.brand")}</strong>
      <small>{t("header.subtitle")}</small>
    </div>
  );
}

function AuthHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div class="viewer-auth__heading">
      <h1>
        {title}
      </h1>
      <p>
        {subtitle}
      </p>
    </div>
  );
}

function AuthField({
  label,
  type,
  value,
  onInput,
  autoFocus,
}: {
  label: string;
  type: string;
  value: string;
  onInput: (v: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <label style="display:flex;flex-direction:column;gap:6px;text-align:left;width:100%">
      <span style="font-size:12px;font-weight:500;color:var(--fg-muted)">
        {label}
      </span>
      <input
        class="memos-auth-input"
        type={type}
        value={value}
        autoFocus={autoFocus}
        onInput={(e) => onInput((e.target as HTMLInputElement).value)}
      />
    </label>
  );
}

function AuthError({ text }: { text: string }) {
  return (
    <div
      style={`
        display:flex;align-items:center;gap:6px;
        color:var(--danger);font-size:13px;
        padding:8px 12px;
        background:rgba(239,68,68,.08);
        border-radius:8px;text-align:left;width:100%
      `}
    >
      <Icon name="circle-alert" size={14} />
      <span>{text}</span>
    </div>
  );
}
