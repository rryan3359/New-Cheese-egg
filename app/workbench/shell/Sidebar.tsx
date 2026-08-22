"use client";

import { WorkbenchLogo } from "./WorkbenchLogo";

export type NavItem = { id: string; number: string; label: string; eyebrow: string };

type SidebarProps = {
  navigation: NavItem[];
  activeView: string;
  healthTone: "live" | "fallback" | "stale";
  sidebarCollapsed: boolean;
  navBadge: (id: string) => number;
  onNavigate: (view: string) => void;
  onToggleSidebar: () => void;
};

export function Sidebar({ navigation, activeView, healthTone, sidebarCollapsed, navBadge, onNavigate, onToggleSidebar }: SidebarProps) {
  return (
    <aside className="workbench-sidebar">
      <button className="workbench-brand" type="button" onClick={() => onNavigate("cockpit")} aria-label="Cheese and Egg 市場駕駛艙">
        <WorkbenchLogo />
      </button>
      <button className="sidebar-collapse" type="button" onClick={onToggleSidebar} aria-label={sidebarCollapsed ? "展開側邊欄" : "收合側邊欄"} aria-expanded={!sidebarCollapsed}>
        {sidebarCollapsed ? "»" : "«"}
      </button>
      <nav className="workbench-nav" aria-label="工作台導覽">
        {navigation.map((item) => {
          const badge = navBadge(item.id);
          return (
            <button
              className={item.id === activeView ? "active" : ""}
              title={sidebarCollapsed ? `${item.number} ${item.label} · ${item.eyebrow}` : undefined}
              type="button"
              key={item.id}
              onClick={() => onNavigate(item.id)}
              aria-label={`${item.number} ${item.label} ${item.eyebrow}`}
              aria-current={item.id === activeView ? "page" : undefined}
            >
              <span className="nav-number">{item.number}</span>
              <span className="nav-copy">
                <b>{item.label}</b>
                <small>{item.eyebrow}</small>
              </span>
              {badge > 0 && <em className="nav-badge">{badge}</em>}
            </button>
          );
        })}
      </nav>
      <div className={`sidebar-status ${healthTone}`}>
        <span />
        <div>
          <b>{healthTone === "live" ? "行情已連線" : healthTone === "fallback" ? "備援行情中" : "顯示最近資料"}</b>
          <small>{healthTone === "live" ? "Binance 即時來源" : healthTone === "fallback" ? "OKX 已接手" : "正在背景重試"}</small>
        </div>
      </div>
    </aside>
  );
}
