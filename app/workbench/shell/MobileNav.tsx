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

export function MobileNav({ navigation, activeView, mobileMoreOpen, navBadge, onNavigate, onToggleMore, onCloseMore }: MobileNavProps) {
  const primary = navigation.slice(0, 4);
  const more = navigation.slice(4);
  const moreActive = mobileMoreOpen || more.some((item) => item.id === activeView);

  return (
    <>
      <nav className="mobile-bottom-nav" aria-label="手機工作台導覽">
        {primary.map((item) => (
          <button type="button" className={item.id === activeView ? "active" : ""} key={item.id} onClick={() => onNavigate(item.id)}>
            <span>{item.number}</span>
            <b>{item.label}</b>
          </button>
        ))}
        <button type="button" className={moreActive ? "active" : ""} onClick={onToggleMore} aria-expanded={mobileMoreOpen}>
          <span>＋</span>
          <b>更多</b>
        </button>
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
            return (
              <button type="button" className={item.id === activeView ? "active" : ""} key={item.id} onClick={() => onNavigate(item.id)}>
                <span>{item.number}</span>
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
