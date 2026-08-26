"use client";

import { useEffect, useRef } from "react";
import { writeStored } from "./storage";

export function useDebouncedPersist(key: string, value: unknown, hydrated: boolean, delayMs = 400) {
  const first = useRef(true);
  useEffect(() => {
    if (!hydrated) return;
    if (first.current) {
      first.current = false;
      writeStored(key, value);
      return;
    }
    const timeout = window.setTimeout(() => writeStored(key, value), delayMs);
    return () => window.clearTimeout(timeout);
  }, [delayMs, hydrated, key, value]);
}
