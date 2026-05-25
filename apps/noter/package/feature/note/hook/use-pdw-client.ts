"use client";

/**
 * memwal Status Hook
 *
 * Simple hook to check if Walrus Memory is configured (MEMWAL_PRIVATE_KEY set).
 * No client-side SDK needed — all operations go through server.
 */

import { useState, useEffect } from "react";

export function useMemWalStatus() {
  const [isConfigured, setIsConfigured] = useState(false);

  useEffect(() => {
    // Check server health to see if Walrus Memory is configured
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
