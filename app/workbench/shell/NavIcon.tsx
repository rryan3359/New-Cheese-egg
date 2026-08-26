type NavIconProps = {
  id: string;
  active?: boolean;
  size?: number;
};

export function NavIcon({ id, active = false, size = 24 }: NavIconProps) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none" as const,
    stroke: "currentColor",
    strokeWidth: active ? 2 : 1.65,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
  };

  switch (id) {
    case "cockpit":
      return <svg {...common}><path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1v-9.5z" /></svg>;
    case "scanner":
      return <svg {...common}><circle cx="11" cy="11" r="6.5" /><path d="M16.5 16.5 21 21" /></svg>;
    case "derivatives":
      return <svg {...common}><path d="M5 19V11M12 19V5M19 19v-7" /></svg>;
    case "strategy":
      return <svg {...common}><circle cx="12" cy="12" r="7.5" /><circle cx="12" cy="12" r="2.2" fill={active ? "currentColor" : "none"} /><path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2" /></svg>;
    case "chart":
      return <svg {...common}><path d="M4 18h16M6 14l3.5-4 3 3L18 6" /></svg>;
    case "alerts":
      return <svg {...common}><path d="M12 3a6 6 0 0 1 6 6c0 4.5 1.5 5.5 1.5 5.5H4.5S6 13.5 6 9a6 6 0 0 1 6-6zM10 19a2 2 0 0 0 4 0" /></svg>;
    case "risk":
      return <svg {...common}><path d="M12 3 4.5 6v5.5c0 4.6 3.2 7.9 7.5 9 4.3-1.1 7.5-4.4 7.5-9V6L12 3z" /></svg>;
    case "journal":
      return <svg {...common}><path d="M7 4h11a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM10 9h6M10 13h6M10 17h4" /></svg>;
    case "health":
      return <svg {...common}><path d="M4 12h3l2-5 3 10 2-5h4" /></svg>;
    case "settings":
      return <svg {...common}><circle cx="12" cy="12" r="3" /><path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6.2 6.2l1.6 1.6M16.2 16.2l1.6 1.6M17.8 6.2l-1.6 1.6M7.8 16.2l-1.6 1.6" /></svg>;
    default:
      return <svg {...common}><circle cx="12" cy="12" r="7" /></svg>;
  }
}
