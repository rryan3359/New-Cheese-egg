"use client";

import { useEffect, useRef } from "react";
import type { NavItem } from "./Sidebar";
import { NavIcon } from "./NavIcon";

type MobileNavProps = {
  navigation: NavItem[];
  activeView: string;
  mobileMoreOpen: boolean;
  navBadge: (id: string) => number;
  onNavigate: (view: string) => void;
  onToggleMore: () => void;
  onCloseMore: () => void;
};

const SHORT_LABEL: Record<string, string> = {
  cockpit: "總攬",
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
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!mobileMoreOpen) return;

    const previousBodyOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    const moreButton = moreButtonRef.current;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";

    const focusable = () => Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );

    window.requestAnimationFrame(() => focusable()[0]?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseMore();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
      window.requestAnimationFrame(() => moreButton?.focus());
    };
  }, [mobileMoreOpen, onCloseMore]);

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
            ref={moreButtonRef}
            type="button"
            className={`mobile-tab mobile-tab--center${moreActive ? " active" : ""}`}
            onClick={onToggleMore}
            aria-expanded={mobileMoreOpen}
            aria-controls="mobile-more-dialog"
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
        <>
        <div className="mobile-more-backdrop" aria-hidden="true" onMouseDown={onCloseMore} />
        <div ref={dialogRef} id="mobile-more-dialog" className="mobile-more-menu" role="dialog" aria-modal="true" aria-labelledby="mobile-more-title">
          <header>
            <b id="mobile-more-title">全部功能</b>
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
        </>
      )}
    </>
  );
}
