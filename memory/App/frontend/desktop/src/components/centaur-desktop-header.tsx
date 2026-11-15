import { PanelLeft, PanelLeftClose, Settings2 } from "lucide-react";
import type { AppRoutePath } from "../app/routes.js";
import type { MessageKey } from "../i18n/messages.js";
import { useTranslation } from "../i18n/use-translation.js";
import { CentaurLockup } from "./centaur-brand.js";
import { PRODUCT_TOUR_MEMORY_NAV_ANCHOR } from "../app/product-tour-layout.js";

const tabs = [
  { path: "/main", label: "nav.workspace" },
  { path: "/memory", label: "memory.nav.memory" },
  { path: "/star-map", label: "nav.starMap" },
  { path: "/space", label: "nav.space" },
  { path: "/boxes", label: "nav.boxes" },
] as const satisfies ReadonlyArray<{ path: AppRoutePath; label: MessageKey }>;

export function CentaurDesktopHeader(props: {
  active: AppRoutePath;
  onNavigate?: (path: AppRoutePath) => void;
  sidebarHidden: boolean;
  onToggleSidebar?: () => void;
}) {
  const { t } = useTranslation();
  const active = props.active === "/memory-sources" ? "/memory" : props.active;
  const sidebarLabel = t(props.sidebarHidden ? "appFrame.showSidebar" : "appFrame.hideSidebar");

  return (
    <header className="centaur-desktop-header">
      <div className="centaur-desktop-header__brand"><CentaurLockup /></div>
      <nav className="centaur-desktop-tabs" aria-label={t("nav.workspaceNavigation")} data-window-drag-exclusion="windows-titlebar">
        {tabs.map(({ path, label }) => (
          <button key={path} type="button" onClick={() => props.onNavigate?.(path)} aria-current={path === active ? "page" : undefined}
            data-tour-anchor={path === "/memory" ? PRODUCT_TOUR_MEMORY_NAV_ANCHOR : undefined}>
            {t(label)}
          </button>
        ))}
      </nav>
      <div className="centaur-desktop-header__actions" data-window-drag-exclusion="windows-titlebar">
        {props.onToggleSidebar && (
          <button type="button" className="windows-titlebar__sidebar" title={sidebarLabel} aria-label={sidebarLabel} onClick={props.onToggleSidebar}>
            {props.sidebarHidden ? <PanelLeft size={17} /> : <PanelLeftClose size={17} />}
          </button>
        )}
        <button type="button" className="centaur-desktop-header__account" aria-label={t("settings.title")} aria-current={active === "/settings" || active === "/wanx-account" ? "page" : undefined} onClick={() => props.onNavigate?.("/settings")}>
          <Settings2 size={18} />
          {t("settings.title")}
        </button>
      </div>
    </header>
  );
}
