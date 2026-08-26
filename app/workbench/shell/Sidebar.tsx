"use client";

import { WorkbenchLogo } from "./WorkbenchLogo";
import { NavIcon } from "./NavIcon";

export type NavItem = { id: string; number: string; label: string; eyebrow: string };

type SidebarProps = {
  navigation: NavItem[];
  activeView: string;
  healthTone: "live" | "stale" | "missing";
  sidebarCollapsed: boolean;
  navBadge: (id: string) => number;
  onNavigate: (view: string) => void;
  onToggleSidebar: () => void;
};

export function Sidebar({ navigation, activeView, healthTone, sidebarCollapsed, navBadge, onNavigate, onToggleSidebar }: SidebarProps) {
  return (
    <aside className="workbench-sidebar">
      <button className="workbench-brand" type="button" onClick={() => onNavigate("cockpit")} aria-label="Cheese and Egg 交易總攬">
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
              <span className="nav-leading" aria-hidden="true">
                <NavIcon id={item.id} active={item.id === activeView} size={18} />
                <span className="nav-number">{item.number}</span>
              </span>
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
          <b>{healthTone === "live" ? "行情已連線" : healthTone === "stale" ? "顯示最近資料" : "行情暫時不可用"}</b>
          <small>{healthTone === "live" ? "OKX 即時來源" : healthTone === "stale" ? "OKX 正在背景重試" : "可使用離線工具"}</small>
        </div>
      </div>
    </aside>
  );
}
