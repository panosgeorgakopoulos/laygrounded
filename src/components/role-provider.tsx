"use client";

// The caller's role, resolved once and shared.
//
// Panels ask `useCan("finance.grant")` rather than fetching a role each. The
// role is NOT in the JWT (the custom access token hook was never enabled), so
// without this every gated control would cost its own request.
//
// WHILE IT LOADS, `can` RETURNS FALSE. That is the safe direction: a control
// that appears and then vanishes is worse than one that appears a moment late,
// and the alternative — assuming permission until told otherwise — puts a
// button in front of someone who will be refused, which reads as a broken
// product rather than as a permission boundary.

import { createContext, useContext, useEffect, useState } from "react";
import { can as canWithRole, type Capability, type Role } from "@/lib/auth/roles";

interface RoleState {
  role: Role | null;
  capabilities: Capability[];
  loading: boolean;
}

const RoleContext = createContext<RoleState>({
  role: null,
  capabilities: [],
  loading: true,
});

export function RoleProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<RoleState>({
    role: null,
    capabilities: [],
    loading: true,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/me");
        if (!res.ok) throw new Error(String(res.status));
        const body = await res.json();
        if (cancelled) return;
        setState({
          role: (body.role as Role) ?? null,
          capabilities: (body.capabilities as Capability[]) ?? [],
          loading: false,
        });
      } catch {
        // Signed out, or the request failed. Either way: no capabilities, which
        // hides gated controls rather than showing ones that would be refused.
        if (!cancelled) setState({ role: null, capabilities: [], loading: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return <RoleContext.Provider value={state}>{children}</RoleContext.Provider>;
}

export function useRole(): RoleState {
  return useContext(RoleContext);
}

/**
 * True when the signed-in user holds `capability`.
 *
 * Prefers the server's resolved list and falls back to deriving it from the
 * role, so a page rendered before the fetch settles still behaves consistently.
 */
export function useCan(capability: Capability): boolean {
  const { role, capabilities, loading } = useRole();
  if (loading) return false;
  if (capabilities.length > 0) return capabilities.includes(capability);
  return role ? canWithRole(role, capability) : false;
}
