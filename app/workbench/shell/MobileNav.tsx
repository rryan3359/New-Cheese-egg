"use client";

import type { NavItem } from "./Sidebar";

type MobileNavProps = {
  navigation: NavItem[];
  activeView: string;
  mobileMoreOpen: boolean;
  navBadge: (id: string) => number;
  onNavigate: (view: string) => void;
  onToggleMore: () => void;
  onCloseMore: () => void;
};

/** Minimal line icons — Threads-style tab bar */
function NavIcon({ id, active }: { id: string; active?: boolean }) {
  const common = {
    width: 26,
    height: 26,
    viewBox: "0 0 24 24",
    fill: "none" as const,
    stroke: "currentColor",
    strokeWidth: active ? 2.15 : 1.75,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
  };

  switch (id) {
    case "cockpit":
      return (
        <svg {...common}>
          <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1v-9.5z" />
        </svg>
      );
    case "scanner":
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="6.5" />
          <path d="M16.5 16.5 21 21" />
        </svg>
      );
    case "derivatives":
      return (
        <svg {...common}>
          <path d="M5 19V11" />
          <path d="M12 19V5" />
          <path d="M19 19v-7" />
        </svg>
      );
    case "strategy":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="7.5" />
          <circle cx="12" cy="12" r="2.2" fill={active ? "currentColor" : "none"} />
          <path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2" />
        </svg>
      );
    case "chart":
      return (
        <svg {...common}>
          <path d="M4 18h16" />
          <path d="M6 14l3.5-4 3 3L18 6" />
        </svg>
      );
    case "alerts":
      return (
        <svg {...common}>
          <path d="M12 3a6 6 0 0 1 6 6c0 4.5 1.5 5.5 1.5 5.5H4.5S6 13.5 6 9a6 6 0 0 1 6-6z" />
          <path d="M10 19a2 2 0 0 0 4 0" />
        </svg>
      );
    case "risk":
      return (
        <svg {...common}>
          <path d="M12 3 4.5 6v5.5c0 4.6 3.2 7.9 7.5 9 4.3-1.1 7.5-4.4 7.5-9V6L12 3z" />
        </svg>
      );
    case "journal":
      return (
        <svg {...common}>
          <path d="M7 4h11a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
          <path d="M10 9h6M10 13h6M10 17h4" />
        </svg>
      );
    case "health":
      return (
        <svg {...common}>
          <path d="M4 12h3l2-5 3 10 2-5h4" />
        </svg>
      );
    case "settings":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6.2 6.2l1.6 1.6M16.2 16.2l1.6 1.6M17.8 6.2l-1.6 1.6M7.8 16.2l-1.6 1.6" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="7" />
        </svg>
      );
  }
}

const SHORT_LABEL: Record<string, string> = {
  cockpit: "駕駛艙",
  scanner: "掃描",
  derivatives: "衍生品",
  strategy: "策略",
  chart: "圖表",
  alerts: "警報",
  risk: "風險",
  journal: "日誌",
  health: "健康",
  settings: "設定",
};

export function MobileNav({
  navigation,
  activeView,
  mobileMoreOpen,
  navBadge,
  onNavigate,
  onToggleMore,
  onCloseMore,
}: MobileNavProps) {
  const left = navigation.slice(0, 2);
  const right = navigation.slice(2, 4);
  const more = navigation.slice(4);
  const moreActive = mobileMoreOpen || more.some((item) => item.id === activeView);

  return (
    <>
      <nav className="mobile-bottom-nav" aria-label="手機工作台導覽">
        <div className="mobile-bottom-nav__inner">
          {left.map((item) => {
            const active = item.id === activeView && !mobileMoreOpen;
            const badge = navBadge(item.id);
            return (
              <button
                type="button"
                className={`mobile-tab${active ? " active" : ""}`}
                key={item.id}
                onClick={() => onNavigate(item.id)}
                aria-current={active ? "page" : undefined}
              >
                <span className="mobile-tab__icon">
                  <NavIcon id={item.id} active={active} />
                  {badge > 0 && <em className="mobile-tab__badge">{badge > 9 ? "9+" : badge}</em>}
                </span>
                <b className="mobile-tab__label">{SHORT_LABEL[item.id] ?? item.label}</b>
              </button>
            );
          })}

          <button
            type="button"
            className={`mobile-tab mobile-tab--center${moreActive ? " active" : ""}`}
            onClick={onToggleMore}
            aria-expanded={mobileMoreOpen}
            aria-label="更多功能"
          >
            <span className="mobile-tab__fab" aria-hidden>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
              </svg>
            </span>
            <b className="mobile-tab__label">更多</b>
          </button>

          {right.map((item) => {
            const active = item.id === activeView && !mobileMoreOpen;
            const badge = navBadge(item.id);
            return (
              <button
                type="button"
                className={`mobile-tab${active ? " active" : ""}`}
                key={item.id}
                onClick={() => onNavigate(item.id)}
                aria-current={active ? "page" : undefined}
              >
                <span className="mobile-tab__icon">
                  <NavIcon id={item.id} active={active} />
                  {badge > 0 && <em className="mobile-tab__badge">{badge > 9 ? "9+" : badge}</em>}
                </span>
                <b className="mobile-tab__label">{SHORT_LABEL[item.id] ?? item.label}</b>
              </button>
            );
          })}
        </div>
      </nav>

      {mobileMoreOpen && (
        <div className="mobile-more-menu" role="dialog" aria-label="更多功能">
          <header>
            <b>全部功能</b>
            <button type="button" onClick={onCloseMore} aria-label="關閉更多功能">
              ×
            </button>
          </header>
          {more.map((item) => {
            const badge = navBadge(item.id);
            const active = item.id === activeView;
            return (
              <button
                type="button"
                className={active ? "active" : ""}
                key={item.id}
                onClick={() => onNavigate(item.id)}
              >
                <span className="mobile-more-menu__icon">
                  <NavIcon id={item.id} active={active} />
                </span>
                <b>{item.label}</b>
                <small>{item.eyebrow}</small>
                {badge > 0 && <em>{badge}</em>}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
