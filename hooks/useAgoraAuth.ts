"use client";

import { useCallback, useEffect, useState } from "react";

export type AgoraAuthMe =
  | { authenticated: false; authMode: "pin" | "bypass" }
  | {
      authenticated: true;
      authMode: "pin" | "bypass";
      user: { id: string; email: string; name: string };
    };

export function useAgoraAuth() {
  const [me, setMe] = useState<AgoraAuthMe | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  const refreshMe = useCallback(async () => {
    const res = await fetch("/api/auth/me", { cache: "no-store" });
    const json = (await res.json()) as AgoraAuthMe;
    setMe(json);
    return json;
  }, []);

  useEffect(() => {
    void refreshMe().catch((err) =>
      console.error("[useAgoraAuth] me failed", err),
    );
  }, [refreshMe]);

  const signIn = useCallback(async (pin: string) => {
    setAuthError(null);
    const res = await fetch("/api/auth/pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    const json = await res.json();
    if (!res.ok) {
      const message = json.error || "Sign-in failed";
      setAuthError(message);
      throw new Error(message);
    }
    await refreshMe();
  }, [refreshMe]);

  const signOut = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    await refreshMe();
  }, [refreshMe]);

  return { me, loading: me === null, authError, signIn, signOut, refreshMe };
}
