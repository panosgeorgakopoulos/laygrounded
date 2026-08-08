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
  /**
   * The caller is authenticated but belongs to no company — `requireAuth()`
   * threw NO_COMPANY.
   *
   * Distinguished from "signed out" because the two need opposite responses:
   * a signed-out user goes to /sign-in, a tenantless one to /onboarding. Both
   * arrive here as a 401, so the ERROR BODY has to be read to tell them apart.
   * Collapsing them is what used to drop a freshly-invited user on an empty
   * dashboard whose every panel returned an error.
   */
  noCompany: boolean;
}

const RoleContext = createContext<RoleState>({
  role: null,
  capabilities: [],
  loading: true,
  noCompany: false,
});

export function RoleProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<RoleState>({
    role: null,
    capabilities: [],
    loading: true,
    noCompany: false,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/me");

        if (!res.ok) {
          // NO_COMPANY and UNAUTHORIZED both come back as 401 (see
          // `api-errors.ts`), so the status alone cannot separate "you have no
          // workspace yet" from "you are signed out". The body can.
          const body = await res.json().catch(() => ({}));
          if (!cancelled) {
            setState({
              role: null,
              capabilities: [],
              loading: false,
              noCompany: body?.error === "NO_COMPANY",
            });
          }
          return;
        }

        const body = await res.json();
        if (cancelled) return;
        setState({
          role: (body.role as Role) ?? null,
          capabilities: (body.capabilities as Capability[]) ?? [],
          loading: false,
          noCompany: false,
        });
      } catch {
        // The request itself failed — offline, or a 500. No capabilities, which
        // hides gated controls rather than showing ones that would be refused.
        // NOT treated as `noCompany`: bouncing somebody to onboarding because
        // their connection dropped would be worse than showing them a stale
        // page, and they may well already have a workspace.
        if (!cancelled) {
          setState({ role: null, capabilities: [], loading: false, noCompany: false });
        }
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
