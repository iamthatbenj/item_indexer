"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// A fresh result may authorize only its own generation. Broadcast messages and
// lifecycle changes can invalidate it, but can never authorize local content.
export function useAccountScope(accountId: string) {
  const generation = useRef(0);
  const mounted = useRef(false);
  const verified = useRef(false);
  const channel = useRef<BroadcastChannel | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const [message, setMessage] = useState("Checking the signed-in account before exposing local text…");

  const assertLive = useCallback((version: number) => {
    if (!mounted.current || version !== generation.current) throw new Error("Account verification was interrupted. Check the original account before resuming pending text.");
  }, []);
  const assertCurrent = useCallback((version: number) => {
    assertLive(version);
    if (!verified.current) throw new Error("Sign in as the original contributor before resuming pending text.");
  }, [assertLive]);
  const invalidate = useCallback((notify = false) => {
    generation.current++;
    if (notify) channel.current?.postMessage(null);
    verified.current = false;
    setAuthorized(false);
    setMessage("Account verification was interrupted. Reconnect and sign in as the original contributor before recovering pending text.");
  }, []);
  const verify = useCallback(async () => {
    const version = ++generation.current;
    verified.current = false; setAuthorized(false);
    try {
      const response = await fetch("/auth/account", { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      const result = await response.json();
      assertLive(version);
      channel.current?.postMessage(response.ok ? result?.id : null);
      if (!response.ok || result?.id !== accountId) throw new Error("Sign in again as the original contributor before saving or recovering pending text.");
      verified.current = true; setAuthorized(true); setMessage("");
      return version;
    } catch {
      if (mounted.current && generation.current === version) {
        verified.current = false; setAuthorized(false);
        setMessage("Reconnect and sign in again as the original contributor before saving or recovering pending text. Retained local copies are not server saves.");
      }
      throw new Error("Reconnect and sign in again as the original contributor before saving or recovering pending text.");
    }
  }, [accountId, assertLive]);
  const current = useCallback(() => {
    const version = generation.current;
    assertCurrent(version);
    return version;
  }, [assertCurrent]);

  useEffect(() => {
    mounted.current = true;
    const connection = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("family-belongings-photo-identity") : null;
    channel.current = connection;
    if (connection) connection.onmessage = event => {
      if (event.data !== accountId) {
        invalidate();
        setMessage("The signed-in account changed. Sign in as the original contributor before recovering pending text.");
      }
    };
    function check() { void verify().catch(() => {}); }
    function visibility() {
      if (document.visibilityState === "hidden") invalidate();
      else check();
    }
    check();
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      mounted.current = false; generation.current++; verified.current = false;
      channel.current = null; connection?.close();
      window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", visibility);
    };
  }, [accountId, invalidate, verify]);

  return { authorized, message, verify, current, assertCurrent, invalidate };
}
