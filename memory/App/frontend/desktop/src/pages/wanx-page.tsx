import { useLayoutEffect, useRef, useState } from "react";
import { AppFrame } from "./app-frame.js";
import { appActions } from "../state/app-actions.js";
import { useAppState } from "../state/app-state.js";
import { useTranslation } from "../i18n/use-translation.js";

const pages = {
  "/boxes": { page: "boxes", title: "nav.boxes" },
  "/space": { page: "space", title: "nav.space" },
  "/star-map": { page: "data", title: "nav.starMap" },
} as const;
type Route = keyof typeof pages;
type Page = Parameters<NonNullable<Window["centaurWorkspace"]>["showWanxPage"]>[0];
type Status = "loading" | "ready" | "missing" | "incompatible" | "unavailable" | "browser";
const guestRoutes = new Set(["/main", "/boxes", "/space", "/star-map", "/settings"]);

export function WanxPage({ route }: { route: Route }) {
  const { t } = useTranslation();
  const { page, title } = pages[route];
  return <AppFrame title={t(title)}><WanxSurface page={page} title={title} /></AppFrame>;
}

export function WanxSurface({ page, title }: { page: Page; title: typeof pages[Route]["title"] | "nav.wanxAccount" | "nav.workspace" | "settings.model" | "settings.title" | "nav.login" }) {
  const { t } = useTranslation();
  const { dispatch } = useAppState();
  const [status, setStatus] = useState<Status>("loading");
  const [attempt, setAttempt] = useState(0);
  const statusRef = useRef<Status>("loading");
  const region = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const bridge = window.centaurWorkspace;
    const element = region.current;
    if (!bridge || !element) { setStatus("browser"); return; }
    let active = true;
    let request = 0;
    let lastBounds = "";
    const update = (next: Status) => {
      statusRef.current = next;
      setStatus(next);
    };
    update("loading");
    const show = () => {
      const bounds = element.getBoundingClientRect();
      const box = { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.floor(bounds.width), height: Math.floor(bounds.height) };
      const key = JSON.stringify(box);
      if (key === lastBounds || box.width <= 0 || box.height <= 0 || statusRef.current === "unavailable") return;
      lastBounds = key;
      const id = ++request;
      void bridge.showWanxPage(page, box).then((next) => {
        if (active && id === request) update(next);
      }, () => { if (active && id === request) update("unavailable"); });
    };
    const frame = requestAnimationFrame(show);
    const observer = new ResizeObserver(show);
    observer.observe(element);
    const unsubscribeNavigate = bridge.onWanxNavigate((destination) => {
      const [path, hash] = destination.split("#");
      if (!path || !guestRoutes.has(path)) return;
      if (path === "/settings") {
        const next = window.location.pathname + window.location.search + (hash ? "#" + hash : "");
        window.history.replaceState(window.history.state, "", next);
        window.dispatchEvent(new Event("hashchange"));
      }
      dispatch(appActions.navigate(path as Route | "/settings" | "/main"));
    });
    const unsubscribeUnavailable = bridge.onWanxUnavailable(() => { ++request; update("unavailable"); });
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      unsubscribeNavigate();
      unsubscribeUnavailable();
      bridge.hideWanxPage();
    };
  }, [page, dispatch, attempt]);

  return <div ref={region} className={page === "login" ? "centaur-wanx-region centaur-wanx-login" : "centaur-wanx-region"}>
      {status !== "ready" && <div className="centaur-wanx-state" role="status">
        <h2>{t(title)}</h2>
        <p>{t(`wanx.${status}`)}</p>
        {(status === "missing" || status === "incompatible" || status === "unavailable") &&
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>{t("wanx.retry")}</button>}
      </div>}
    </div>;
}
