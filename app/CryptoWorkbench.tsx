"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { StrategyName, Timeframe } from "../lib/market/types";
import type { AlertRule, JournalEntry, WorkbenchSettings } from "../lib/workbench/types";
import { defaultSettings, parseStored, storageKeys, writeStored } from "./hooks/storage";
import { useAlerts } from "./hooks/useAlerts";
import { useDebouncedPersist } from "./hooks/useDebouncedPersist";
import { useMarketData } from "./hooks/useMarketData";
import { usePersistence } from "./hooks/usePersistence";
import {
  ChartView,
  CockpitView,
  DerivativesView,
  EmptyState,
  ScannerView,
  StrategyView,
} from "./workbench/MarketViews";
import { AlertsView, HealthView, JournalView, RiskView, SettingsView } from "./workbench/ToolViews";
import { DataBanners } from "./workbench/shell/DataBanners";
import { MobileNav } from "./workbench/shell/MobileNav";
import { PriceTicker } from "./workbench/shell/PriceTicker";
import { Sidebar } from "./workbench/shell/Sidebar";
import { Topbar } from "./workbench/shell/Topbar";

type ViewId = "cockpit" | "scanner" | "derivatives" | "strategy" | "chart" | "alerts" | "risk" | "journal" | "health" | "settings";
type ThemeMode = "light" | "dark";

const navigation = [
  { id: "cockpit", number: "01", label: "市場駕駛艙", eyebrow: "MARKET COCKPIT" },
  { id: "scanner", number: "02", label: "機會掃描器", eyebrow: "OPPORTUNITY SCANNER" },
  { id: "derivatives", number: "03", label: "衍生品", eyebrow: "DERIVATIVES" },
  { id: "strategy", number: "04", label: "策略工作台", eyebrow: "STRATEGY DESK" },
  { id: "chart", number: "05", label: "圖表決策", eyebrow: "CHART WORKSPACE" },
  { id: "alerts", number: "06", label: "警報中心", eyebrow: "ALERT CENTER" },
  { id: "risk", number: "07", label: "風險管理", eyebrow: "RISK MANAGER" },
  { id: "journal", number: "08", label: "交易日誌", eyebrow: "TRADING JOURNAL" },
  { id: "health", number: "09", label: "資料健康", eyebrow: "DATA HEALTH" },
  { id: "settings", number: "10", label: "設定", eyebrow: "SETTINGS" },
] as const;

export default function CryptoWorkbench() {
  const [activeView, setActiveView] = useState<ViewId>("cockpit");
  const [selectedSymbol, setSelectedSymbol] = useState("BTCUSDT");
  const [selectedTimeframe, setSelectedTimeframe] = useState<Timeframe>("1h");
  const [selectedStrategy, setSelectedStrategy] = useState<StrategyName | null>(null);
  const [journal, setJournal] = useState<JournalEntry[]>([]);
  const [settings, setSettings] = useState<WorkbenchSettings>(defaultSettings);
  const [hydrated, setHydrated] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>("light");

  const {
    persistence,
    persistenceReason,
    setPersistenceReason,
    persistenceRef,
    persistRecord,
    persistAlertEvaluation,
    deleteRecord,
    loadFromCloud,
  } = usePersistence();

  const { alerts, setAlerts, alertEvents, setAlertEvents, toasts, setToasts, alertsRef, evaluateCurrentAlerts } = useAlerts({
    persistenceRef,
    persistRecord,
    persistAlertEvaluation,
    setPersistenceReason,
  });

  const { data, loading, refreshing, fallbackTesting, loadStage, error, refresh, abortAllMarketRequests, hydrateFromCache } = useMarketData({
    evaluateCurrentAlerts,
    refreshSeconds: settings.refreshSeconds,
    hydrated,
  });

  useDebouncedPersist(storageKeys.alerts, alerts, hydrated);
  useDebouncedPersist(storageKeys.alertEvents, alertEvents, hydrated);
  useDebouncedPersist(storageKeys.journal, journal, hydrated);

  useEffect(() => {
    if (!hydrated) return;
    writeStored(storageKeys.settings, settings);
    const timeout = window.setTimeout(() => {
      void persistRecord("settings", settings);
    }, 700);
    return () => window.clearTimeout(timeout);
  }, [hydrated, persistRecord, settings]);

  const navigate = useCallback((view: string) => {
    if (!navigation.some((item) => item.id === view)) return;
    const next = view as ViewId;
    setActiveView(next);
    setMobileMoreOpen(false);
    window.history.replaceState(null, "", `#${next}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const openChart = useCallback(
    (symbol: string, timeframe: Timeframe = "1h", strategy: StrategyName | undefined = undefined) => {
      setSelectedSymbol(symbol);
      setSelectedTimeframe(timeframe);
      setSelectedStrategy(strategy ?? null);
      navigate("chart");
    },
    [navigate],
  );

  useEffect(() => {
    const localAlerts = parseStored<AlertRule[]>(storageKeys.alerts, []);
    const localEvents = parseStored(storageKeys.alertEvents, [] as typeof alertEvents);
    const localJournal = parseStored<JournalEntry[]>(storageKeys.journal, []);
    const localSettings = { ...defaultSettings, ...parseStored<WorkbenchSettings>(storageKeys.settings, defaultSettings) };
    const hash = window.location.hash.slice(1);
    const collapsed = parseStored<boolean>(storageKeys.sidebar, false);
    const savedTheme = localStorage.getItem(storageKeys.theme) === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = savedTheme;

    queueMicrotask(() => {
      if (navigation.some((item) => item.id === hash)) setActiveView(hash as ViewId);
      hydrateFromCache();
      setAlerts(localAlerts);
      alertsRef.current = localAlerts;
      setAlertEvents(localEvents);
      setJournal(localJournal);
      setSettings(localSettings);
      setSidebarCollapsed(collapsed);
      setTheme(savedTheme);
      setHydrated(true);
    });

    const controller = new AbortController();
    void (async () => {
      const cloud = await loadFromCloud(controller.signal);
      if (cloud) {
        setAlerts(cloud.alerts);
        alertsRef.current = cloud.alerts;
        setAlertEvents(cloud.alertEvents);
        setJournal(cloud.journal);
        setSettings({ ...defaultSettings, ...cloud.settings });
      }
      if (!controller.signal.aborted) void refresh();
    })();

    return () => {
      controller.abort();
      abortAllMarketRequests();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleSidebar = () =>
    setSidebarCollapsed((current) => {
      const next = !current;
      writeStored(storageKeys.sidebar, next);
      return next;
    });

  const toggleTheme = () =>
    setTheme((current) => {
      const next = current === "light" ? "dark" : "light";
      document.documentElement.dataset.theme = next;
      localStorage.setItem(storageKeys.theme, next);
      return next;
    });

  const upsertAlert = (rule: AlertRule) => {
    setAlerts((current) => [rule, ...current.filter((item) => item.id !== rule.id)]);
    void persistRecord("alert", rule);
  };
  const deleteAlert = (id: string) => {
    setAlerts((current) => current.filter((item) => item.id !== id));
    setAlertEvents((current) => current.filter((item) => item.alertId !== id));
    void deleteRecord("alert", id);
  };
  const upsertJournal = (entry: JournalEntry) => {
    setJournal((current) => [entry, ...current.filter((item) => item.id !== entry.id)]);
    void persistRecord("journal", entry);
  };
  const deleteJournal = (id: string) => {
    setJournal((current) => current.filter((item) => item.id !== id));
    void deleteRecord("journal", id);
  };
  const updateSettings = (next: WorkbenchSettings) => setSettings(next);

  const healthTone = useMemo((): "live" | "fallback" | "stale" => {
    if (error) return "stale";
    if (data?.assets.some((asset) => asset.price.state === "fallback") || data?.health.some((provider) => provider.state === "fallback")) return "fallback";
    if (data?.health.some((provider) => provider.state === "missing" || provider.state === "stale")) return "stale";
    return "live";
  }, [data, error]);

  const activeLabel = navigation.find((item) => item.id === activeView)?.label ?? "市場駕駛艙";
  const updatedAt = data ? new Date(data.updatedAt).toLocaleTimeString("zh-TW", { hour12: false }) : "—";
  const warningCount = data?.health.filter((provider) => provider.state === "missing" || provider.state === "fallback").length ?? 0;
  const triggeredCount = alerts.filter((alert) => alert.currentStatus === "triggered").length;
  const navBadge = useCallback((id: string) => (id === "alerts" ? triggeredCount : id === "health" ? warningCount : 0), [triggeredCount, warningCount]);

  const renderView = () => {
    if (!data) {
      return (
        <EmptyState
          title={loading ? `載入中 · ${loadStage}` : "目前沒有可用市場資料"}
          copy={
            error ??
            (loading
              ? "正在從 OKX 抓取價格、資金費率、OI／多空比與 K 線，請稍候數秒。"
              : "正在從 OKX 取得永續合約行情。")
          }
        />
      );
    }
    switch (activeView) {
      case "scanner":
        return <ScannerView data={data} watchlist={settings.watchlist} onOpenChart={openChart} />;
      case "derivatives":
        return <DerivativesView data={data} />;
      case "strategy":
        return <StrategyView data={data} onOpenChart={openChart} />;
      case "chart":
        return (
          <ChartView
            key={`${selectedSymbol}-${selectedTimeframe}-${selectedStrategy ?? "default"}`}
            data={data}
            symbol={selectedSymbol}
            initialTimeframe={selectedTimeframe}
            initialStrategy={selectedStrategy}
            watchlist={settings.watchlist}
            onSymbolChange={setSelectedSymbol}
            theme={theme}
          />
        );
      case "alerts":
        return (
          <AlertsView
            data={data}
            alerts={alerts}
            events={alertEvents}
            watchlist={settings.watchlist}
            persistence={persistence}
            onUpsert={upsertAlert}
            onDelete={deleteAlert}
          />
        );
      case "risk":
        return <RiskView data={data} settings={settings} journal={journal} />;
      case "journal":
        return <JournalView journal={journal} persistence={persistence} onUpsert={upsertJournal} onDelete={deleteJournal} />;
      case "health":
        return <HealthView data={data} fallbackTesting={fallbackTesting} onFallbackTest={() => void refresh(true)} />;
      case "settings":
        return <SettingsView settings={settings} persistence={persistence} onChange={updateSettings} data={data} />;
      default:
        return <CockpitView data={data} watchlist={settings.watchlist} onNavigate={navigate} onOpenChart={openChart} />;
    }
  };

  return (
    <main className={sidebarCollapsed ? "crypto-workbench sidebar-collapsed" : "crypto-workbench"}>
      <Sidebar
        navigation={[...navigation]}
        activeView={activeView}
        healthTone={healthTone}
        sidebarCollapsed={sidebarCollapsed}
        navBadge={navBadge}
        onNavigate={navigate}
        onToggleSidebar={toggleSidebar}
      />
      <MobileNav
        navigation={[...navigation]}
        activeView={activeView}
        mobileMoreOpen={mobileMoreOpen}
        navBadge={navBadge}
        onNavigate={navigate}
        onToggleMore={() => setMobileMoreOpen((current) => !current)}
        onCloseMore={() => setMobileMoreOpen(false)}
      />
      <section className="workbench-main">
        <Topbar
          activeLabel={activeLabel}
          persistenceLabel={persistence === "d1" ? "私人同步" : ""}
          updatedAt={updatedAt}
          theme={theme}
          refreshing={refreshing}
          fallbackTesting={fallbackTesting}
          loading={loading}
          onToggleTheme={toggleTheme}
          onRefresh={() => void refresh()}
        />
        <PriceTicker data={data} onSelect={(symbol) => openChart(symbol)} />
        <div className="workbench-content">
          <DataBanners
            loadStage={loadStage}
            healthTone={healthTone}
            data={data}
            error={error}
            persistence={persistence}
            persistenceReason={persistenceReason}
            toasts={toasts}
            onDismissToast={(id) => setToasts((current) => current.filter((item) => item.id !== id))}
            onRefresh={() => void refresh()}
            onNavigate={navigate}
            hideStatusDetails
            statusOpen={false}
          />
          {renderView()}
          <footer className="workbench-footer">
            <span>Cheese&Egg · 看懂市場，再決定是否交易。</span>
            <span>僅供研究與風險規劃，不構成投資建議</span>
          </footer>
        </div>
      </section>
    </main>
  );
}
