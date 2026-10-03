"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AuditDetail } from "@/shared/types";
import { isActive, requestJson } from "./ui";

export function useAudit(id: string) {
  const [audit, setAudit] = useState<AuditDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const requestVersion = useRef(0);
  const reload = useCallback(async () => {
    const version = ++requestVersion.current;
    try {
      const data = await requestJson<{ audit: AuditDetail }>(`/api/audits/${encodeURIComponent(id)}`);
      if (version !== requestVersion.current) return;
      setAudit(data.audit);
      setError(null);
    } catch (cause) { if (version === requestVersion.current) setError(cause instanceof Error ? cause.message : "The audit could not be loaded."); }
    finally { if (version === requestVersion.current) setLoading(false); }
  }, [id]);
  useEffect(() => {
    setAudit(null);
    setError(null);
    setLoading(true);
    void reload();
    return () => { requestVersion.current += 1; };
  }, [reload]);
  const active = audit ? isActive(audit.status) : false;
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => { void reload(); }, 1500);
    return () => window.clearInterval(timer);
  }, [active, reload]);
  return { audit, error, loading, reload };
}
