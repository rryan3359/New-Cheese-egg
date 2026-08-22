"use client";

import { useCallback, useRef, useState, type MutableRefObject } from "react";
import type { AlertEvent, AlertRule, JournalEntry, UserDataPayload, WorkbenchSettings } from "../../lib/workbench/types";

export type PersistenceMode = "d1" | "device";

type UsePersistenceResult = {
  persistence: PersistenceMode;
  persistenceReason: string;
  setPersistence: (mode: PersistenceMode) => void;
  setPersistenceReason: (reason: string) => void;
  persistenceRef: MutableRefObject<PersistenceMode>;
  persistRecord: (entity: "alert" | "alert_event" | "journal" | "settings", record: unknown) => Promise<boolean>;
  persistAlertEvaluation: (rules: AlertRule[], events: AlertEvent[]) => Promise<boolean>;
  deleteRecord: (entity: "alert" | "journal", id: string) => Promise<void>;
  loadFromCloud: (signal: AbortSignal) => Promise<{
    alerts: AlertRule[];
    alertEvents: AlertEvent[];
    journal: JournalEntry[];
    settings: WorkbenchSettings;
  } | null>;
};

export function usePersistence(): UsePersistenceResult {
  const [persistence, setPersistence] = useState<PersistenceMode>("device");
  const [persistenceReason, setPersistenceReason] = useState("正在確認私人同步是否可用");
  const persistenceRef = useRef<PersistenceMode>("device");

  const persistRecord = useCallback(async (entity: "alert" | "alert_event" | "journal" | "settings", record: unknown) => {
    if (persistenceRef.current !== "d1") return false;
    try {
      const response = await fetch("/api/user-data", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entity, record }),
      });
      if (!response.ok) throw new Error(`D1 save ${response.status}`);
      return true;
    } catch {
      setPersistence("device");
      persistenceRef.current = "device";
      setPersistenceReason("私人同步暫時失敗；最新狀態已安全保存在此裝置");
      return false;
    }
  }, []);

  const persistAlertEvaluation = useCallback(async (rules: AlertRule[], events: AlertEvent[]) => {
    if (persistenceRef.current !== "d1") return false;
    try {
      const response = await fetch("/api/user-data", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entity: "alert_evaluation", rules, events }),
      });
      if (!response.ok) throw new Error(`D1 evaluation save ${response.status}`);
      return true;
    } catch {
      setPersistence("device");
      persistenceRef.current = "device";
      setPersistenceReason("雲端保存暫時失敗；最新警報狀態已留在這台裝置，重新整理也不會重複提醒");
      return false;
    }
  }, []);

  const deleteRecord = useCallback(async (entity: "alert" | "journal", id: string) => {
    if (persistenceRef.current !== "d1") return;
    try {
      const response = await fetch("/api/user-data", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entity, id }),
      });
      if (!response.ok) throw new Error(`D1 delete ${response.status}`);
    } catch {
      setPersistence("device");
      persistenceRef.current = "device";
      setPersistenceReason("私人同步刪除失敗；目前狀態已降級為此裝置版本");
    }
  }, []);

  const loadFromCloud = useCallback(async (signal: AbortSignal) => {
    try {
      const response = await fetch("/api/user-data", { cache: "no-store", signal });
      const payload = (await response.json()) as UserDataPayload & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? `同步服務 ${response.status}`);
      // Vercel / 無 D1：API 會回 persistence: "device"
      if (payload.persistence !== "d1") {
        setPersistence("device");
        persistenceRef.current = "device";
        setPersistenceReason(payload.error ?? "設定與紀錄保存在這台裝置；即時行情不受影響");
        return null;
      }
      setPersistence("d1");
      persistenceRef.current = "d1";
      setPersistenceReason("設定與紀錄已開啟私人雲端同步");
      return {
        alerts: payload.alerts,
        alertEvents: payload.alertEvents,
        journal: payload.journal,
        settings: payload.settings,
      };
    } catch (reason) {
      if ((reason as Error).name !== "AbortError") {
        setPersistence("device");
        persistenceRef.current = "device";
        setPersistenceReason("設定與紀錄保存在這台裝置；即時行情不受影響");
      }
      return null;
    }
  }, []);

  return {
    persistence,
    persistenceReason,
    setPersistence,
    setPersistenceReason,
    persistenceRef,
    persistRecord,
    persistAlertEvaluation,
    deleteRecord,
    loadFromCloud,
  };
}
