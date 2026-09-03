"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { StrategyName, StrategyResult, Timeframe } from "../lib/market/types";
import type { AlertRule, JournalEntry, WorkbenchSettings } from "../lib/workbench/types";
import { defaultSettings, parseStored, storageKeys, writeStored } from "./hooks/storage";
import { useAlerts } from "./hooks/useAlerts";
import { useDebouncedPersist } from "./hooks/useDebouncedPersist";
import { useMarketData } from "./hooks/useMarketData";
import { usePersistence } from "./hooks/usePersistence";
import {
  ChartView,
  CockpitView,
  CrossSectionView,
  DerivativesView,
  EmptyState,
  ScannerView,
  StrategyView,
  WatchlistView,
} from "./workbench/MarketViews";
import { AlertsView, HealthView, JournalView, RiskView, SettingsView } from "./workbench/ToolViews";
import { DataBanners } from "./workbench/shell/DataBanners";
import { MobileNav } from "./workbench/shell/MobileNav";
import { PriceTicker } from "./workbench/shell/PriceTicker";
import { Sidebar } from "./workbench/shell/Sidebar";
import { Topbar } from "./workbench/shell/Topbar";

type ViewId = "cockpit" | "scanner" | "watchlist" | "derivatives" | "strategy" | "chart" | "analytics" | "alerts" | "risk" | "journal" | "health" | "settings";
type ThemeMode = "light" | "dark";

const navigation = [
  { id: "cockpit", number: "01", label: "交易總攬", eyebrow: "TRADING OVERVIEW" },
  { id: "scanner", number: "02", label: "機會掃描器", eyebrow: "OPPORTUNITY SCANNER" },
  { id: "watchlist", number: "03", label: "觀察清單", eyebrow: "WATCHLIST" },
  { id: "derivatives", number: "04", label: "市場數據", eyebrow: "MARKET DATA" },
  { id: "strategy", number: "05", label: "策略工作台", eyebrow: "STRATEGY DESK" },
  { id: "chart", number: "06", label: "圖表決策", eyebrow: "CHART WORKSPACE" },
  { id: "analytics", number: "07", label: "橫截面分析", eyebrow: "CROSS-SECTION" },
  { id: "alerts", number: "08", label: "警報中心", eyebrow: "ALERT CENTER" },
  { id: "risk", number: "09", label: "風險管理", eyebrow: "RISK MANAGER" },
  { id: "journal", number: "10", label: "交易日誌", eyebrow: "TRADING JOURNAL" },
  { id: "health", number: "11", label: "資料健康", eyebrow: "DATA HEALTH" },
  { id: "settings", number: "12", label: "設定", eyebrow: "SETTINGS" },
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

  const { data, loading, refreshing, loadStage, error, refresh, abortAllMarketRequests, hydrateFromCache } = useMarketData({
    evaluateCurrentAlerts,
    refreshSeconds: settings.refreshSeconds,
    hydrated,
    feeRate: settings.defaultFeeRate,
    slippageRate: settings.defaultSlippageRate,
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
    const storedSettings = parseStored<WorkbenchSettings>(storageKeys.settings, defaultSettings);
    const localSettings = { ...defaultSettings, ...storedSettings, minimumNetRr: Math.max(1.5, storedSettings.minimumNetRr ?? 1.5) };
    const hash = window.location.hash.slice(1);
    const collapsed = parseStored<boolean>(storageKeys.sidebar, false);
    const savedTheme = localStorage.getItem(storageKeys.theme) === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = savedTheme;
    document.documentElement.style.colorScheme = savedTheme;
    hydrateFromCache();

    queueMicrotask(() => {
      if (navigation.some((item) => item.id === hash)) setActiveView(hash as ViewId);
      setAlerts(localAlerts);
      alertsRef.current = localAlerts;
      setAlertEvents(localEvents);
      setJournal(localJournal);
      setSettings(localSettings);
      setSidebarCollapsed(collapsed);
      setTheme(savedTheme);
      setHydrated(true);
    });

    void refresh();

    const controller = new AbortController();
    void (async () => {
      const cloud = await loadFromCloud(controller.signal);
      if (cloud) {
        setAlerts(cloud.alerts);
        alertsRef.current = cloud.alerts;
        setAlertEvents(cloud.alertEvents);
        setJournal(cloud.journal);
        setSettings({ ...defaultSettings, ...cloud.settings, minimumNetRr: Math.max(1.5, cloud.settings.minimumNetRr ?? 1.5) });
      }
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
      document.documentElement.style.colorScheme = next;
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
  const createSetupAlert = (setup: StrategyResult) => {
    const now = new Date().toISOString();
    upsertAlert({
      id: crypto.randomUUID(), symbol: setup.symbol, type: "strategy_eligible", timeframe: setup.timeframe,
      strategy: setup.strategy, strategyVersion: 13, strategyLegacy: false, strategyModel: setup.submodel, strategyRuleset: "v13.1", operator: "above", threshold: 1.5,
      thresholdUpper: null, referenceValue: null, enabled: true, cooldownMinutes: 60, dedupeKey: null,
      lastEvaluatedAt: null, lastTriggeredAt: null, triggerCount: 0, currentStatus: "watching",
      lastReason: "等待硬條件完整且淨 RR 至少 1.5（B 級或 A 級）", createdAt: now,
    });
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
  const toggleWatchlist = (symbol: string) => setSettings((current) => ({
    ...current,
    watchlist: current.watchlist.includes(symbol) ? current.watchlist.filter((item) => item !== symbol) : [...current.watchlist, symbol],
  }));
  const toggleMobileMore = useCallback(() => setMobileMoreOpen((current) => !current), []);
  const closeMobileMore = useCallback(() => setMobileMoreOpen(false), []);

  const healthTone = useMemo((): "live" | "stale" | "missing" => {
    if (!data) return "missing";
    if (error) return "stale";
    const marketProvider = data.health.find((provider) => provider.name === "OKX");
    if (!marketProvider || marketProvider.state === "missing") return "missing";
    if (marketProvider.state === "stale" || data.pipeline.stage === "showing-stale") return "stale";
    return "live";
  }, [data, error]);

  const activeLabel = navigation.find((item) => item.id === activeView)?.label ?? "交易總攬";
  const updatedAt = data ? new Date(data.updatedAt).toLocaleTimeString("zh-TW", { hour12: false }) : "—";
  const warningCount = data?.health.filter((provider) => provider.state === "missing" || provider.state === "stale").length ?? (error ? 1 : 0);
  const triggeredCount = alerts.filter((alert) => alert.currentStatus === "triggered").length;
  const navBadge = useCallback((id: string) => (id === "alerts" ? triggeredCount : id === "health" ? warningCount : 0), [triggeredCount, warningCount]);

  const renderView = () => {
    const marketUnavailable = (label: string) => (
      <EmptyState
        title={loading ? `${label}載入中 · ${loadStage}` : `${label}暫時不可用`}
        copy={
          loading
            ? "正在從 OKX 取得關鍵行情；其他不依賴即時價格的功能仍可使用。"
            : error ?? "目前沒有可用行情，請稍後重試"
        }
        actionLabel={loading ? undefined : "重新嘗試"}
        onAction={loading ? undefined : () => void refresh()}
      />
    );

    if (!data && ["cockpit", "scanner", "watchlist", "derivatives", "strategy", "chart", "analytics"].includes(activeView)) {
      const label = navigation.find((item) => item.id === activeView)?.label ?? "市場功能";
      return marketUnavailable(label);
    }

    switch (activeView) {
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
        return <RiskView settings={settings} />;
      case "journal":
        return <JournalView journal={journal} persistence={persistence} onUpsert={upsertJournal} onDelete={deleteJournal} />;
      case "health":
        return <HealthView data={data} refreshing={refreshing} onRefresh={() => void refresh()} />;
      case "settings":
        return <SettingsView settings={settings} persistence={persistence} onChange={updateSettings} data={data} />;
      case "scanner":
        return data ? <ScannerView data={data} watchlist={settings.watchlist} minimumNetRr={settings.minimumNetRr} onOpenChart={openChart} /> : marketUnavailable("機會掃描器");
      case "watchlist":
        return data ? <WatchlistView data={data} watchlist={settings.watchlist} onOpenChart={openChart} onToggleWatchlist={toggleWatchlist} /> : marketUnavailable("觀察清單");
      case "derivatives":
        return data ? <DerivativesView data={data} /> : marketUnavailable("市場數據");
      case "strategy":
        return data ? <StrategyView data={data} onOpenChart={openChart} /> : marketUnavailable("策略工作台");
      case "chart":
        return data ? (
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
        ) : marketUnavailable("圖表決策");
      case "analytics":
        return data ? <CrossSectionView data={data} onOpenChart={openChart} /> : marketUnavailable("橫截面分析");
      default:
        return data ? <CockpitView data={data} watchlist={settings.watchlist} onNavigate={navigate} onOpenChart={openChart} onCreateAlert={createSetupAlert} onToggleWatchlist={toggleWatchlist} /> : marketUnavailable("交易總攬");
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
        onToggleMore={toggleMobileMore}
        onCloseMore={closeMobileMore}
      />
      <section className="workbench-main">
        <Topbar
          activeLabel={activeLabel}
          persistenceLabel={persistence === "d1" ? "私人同步" : "此裝置"}
          updatedAt={updatedAt}
          theme={theme}
          refreshing={refreshing}
          loading={loading}
          onToggleTheme={toggleTheme}
          onRefresh={() => void refresh()}
        />
        <PriceTicker data={data} loading={loading} error={error} onSelect={(symbol) => openChart(symbol)} />
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
            <span>Cheese&Egg · 日內量化決策台</span>
            <span>僅供研究與風險規劃，不構成投資建議</span>
          </footer>
        </div>
      </section>
    </main>
  );
}
