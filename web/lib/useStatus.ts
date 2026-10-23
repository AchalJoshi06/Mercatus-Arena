"use client";

import { useEffect, useState } from "react";
import { api, STATUS } from "./api";
import { poller } from "./poller";

let cachedStatus: STATUS | null = null;
const statusListeners = new Set<(s: STATUS | null) => void>();
let pollerUnsub: (() => void) | null = null;

export function useStatus(intervalMs = 2500): STATUS | null {
  const [status, setStatus] = useState<STATUS | null>(cachedStatus);

  useEffect(() => {
    statusListeners.add(setStatus);
    if (!pollerUnsub) {
      const load = () =>
        api<STATUS>("/api/market/status")
          .then((s) => {
            cachedStatus = s;
            statusListeners.forEach((fn) => fn(s));
          })
          .catch(() => {});
      void load();
      pollerUnsub = poller.register("market:status", load, intervalMs);
    }
    return () => {
      statusListeners.delete(setStatus);
      if (statusListeners.size === 0 && pollerUnsub) {
        pollerUnsub();
        pollerUnsub = null;
      }
    };
  }, [intervalMs]);

  return status;
}
