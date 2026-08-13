"use client";

/** Check the authenticated user's Walrus Memory connection. */

import { useState, useEffect } from "react";
import { STORAGE_KEYS } from "@/feature/auth/constant";
import type { SessionData } from "@/feature/auth/domain/type";

function getSessionId(): string | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEYS.sessionId);
    return raw ? (JSON.parse(raw) as SessionData).sessionId : null;
  } catch {
    return null;
  }
}

export function useMemWalStatus() {
  const [isConfigured, setIsConfigured] = useState(false);

  useEffect(() => {
    const sessionId = getSessionId();
    if (!sessionId) return;

    fetch("/api/memory/health", {
      headers: { "x-session-id": sessionId },
    })
      .then((res) => {
        setIsConfigured(res.ok);
      })
      .catch(() => {
        setIsConfigured(false);
      });
  }, []);

  return { isConfigured };
}
