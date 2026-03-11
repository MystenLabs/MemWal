"use client";

/**
 * MemWal V2 Status Hook
 *
 * Simple hook to check if MemWal is configured (MEMWAL_KEY set).
 * No client-side SDK needed — all operations go through server.
 */

import { useState, useEffect } from "react";

export function useMemWalStatus() {
  const [isConfigured, setIsConfigured] = useState(false);

  useEffect(() => {
    // Check server health to see if MemWal is configured
    fetch("/api/memory/health")
      .then((res) => {
        setIsConfigured(res.ok);
      })
      .catch(() => {
        setIsConfigured(false);
      });
  }, []);

  return { isConfigured };
}
