"use client";

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { evaluateAlerts } from "../../lib/alerts/engine";
import type { MarketHubPayload } from "../../lib/market/types";
import type { AlertEvent, AlertRule } from "../../lib/workbench/types";
import type { PersistenceMode } from "./usePersistence";
import { storageKeys, writeStored } from "./storage";

type UseAlertsOptions = {
  persistenceRef: MutableRefObject<PersistenceMode>;
  persistRecord: (entity: "alert" | "alert_event" | "journal" | "settings", record: unknown) => Promise<boolean>;
  persistAlertEvaluation: (rules: AlertRule[], events: AlertEvent[]) => Promise<boolean>;
  setPersistenceReason: (reason: string) => void;
};

export function useAlerts({ persistenceRef, persistRecord, persistAlertEvaluation, setPersistenceReason }: UseAlertsOptions) {
  const [alerts, setAlerts] = useState<AlertRule[]>([]);
  const [alertEvents, setAlertEvents] = useState<AlertEvent[]>([]);
  const [toasts, setToasts] = useState<AlertEvent[]>([]);
  const alertsRef = useRef<AlertRule[]>([]);

  useEffect(() => {
    alertsRef.current = alerts;
  }, [alerts]);

  const notifyEvents = useCallback(
    (events: AlertEvent[]) => {
      if (!events.length) return;
      setToasts((current) => [...events, ...current].slice(0, 4));
      setAlertEvents((current) => {
        const next = [...events, ...current.filter((saved) => !events.some((event) => event.dedupeKey === saved.dedupeKey))].slice(0, 100);
        writeStored(storageKeys.alertEvents, next);
        return next;
      });
      if (!("Notification" in window) || Notification.permission !== "granted") return;
      events.forEach((event) => {
        try {
          new Notification(`Cheese&Egg · ${event.symbol.replace("USDT", "")}`, { body: event.reason, tag: event.dedupeKey });
          const browserEvent: AlertEvent = {
            ...event,
            id: crypto.randomUUID(),
            dedupeKey: `${event.dedupeKey}:browser`,
            channel: "browser",
            deliveryStatus: "delivered",
          };
          setAlertEvents((current) => [browserEvent, ...current].slice(0, 100));
          void persistRecord("alert_event", browserEvent);
        } catch {
          // In-app delivery remains valid.
        }
      });
    },
    [persistRecord],
  );

  const evaluateCurrentAlerts = useCallback(
    async (snapshot: MarketHubPayload) => {
      if (!alertsRef.current.length) return;
      if (persistenceRef.current === "d1") {
        try {
          const response = await fetch("/api/alerts/evaluate", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ snapshot }),
          });
          const result = (await response.json()) as { rules?: AlertRule[]; events?: AlertEvent[]; snapshotUpdatedAt?: string };
          if (!response.ok || !result.rules || !result.events || result.snapshotUpdatedAt !== snapshot.updatedAt) {
            throw new Error("server alert evaluation failed");
          }
          setAlerts(result.rules);
          alertsRef.current = result.rules;
          writeStored(storageKeys.alerts, result.rules);
          notifyEvents(result.events);
          return;
        } catch {
          setPersistenceReason("雲端警報暫時無法判定；已改用畫面上的同一份行情繼續檢查");
        }
      }
      const result = evaluateAlerts(alertsRef.current, snapshot);
      setAlerts(result.rules);
      alertsRef.current = result.rules;
      writeStored(storageKeys.alerts, result.rules);
      notifyEvents(result.events);
      await persistAlertEvaluation(result.rules, result.events);
    },
    [notifyEvents, persistAlertEvaluation, persistenceRef, setPersistenceReason],
  );

  useEffect(() => {
    if (!toasts.length) return;
    const timeout = window.setTimeout(() => setToasts((current) => current.slice(0, -1)), 7000);
    return () => window.clearTimeout(timeout);
  }, [toasts]);

  return {
    alerts,
    setAlerts,
    alertEvents,
    setAlertEvents,
    toasts,
    setToasts,
    alertsRef,
    evaluateCurrentAlerts,
  };
}
