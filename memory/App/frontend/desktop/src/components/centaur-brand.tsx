import markUrl from "../assets/brand/centaurai-mark.png";
import { useTranslation } from "../i18n/use-translation.js";

export function CentaurMark({ size = 34 }: { size?: number }) {
  return <img className="centaur-mark" src={markUrl} alt="" width={size} height={size} draggable={false} />;
}

export function CentaurLockup({ className = "" }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <span className={`centaur-lockup ${className}`}>
      <CentaurMark />
      <span className="centaur-lockup__text">
        <strong>{t("brand.name")}</strong>
        <small>{t("brand.subtitle")}</small>
      </span>
    </span>
  );
}
