"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Session, User } from "@supabase/supabase-js";

type AuthState = {
  user: User | null;
  session: Session | null;
  loading: boolean;
};

const SupabaseAuthContext = createContext<AuthState>({
  user: null,
  session: null,
  loading: true,
});

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      })
  );

  const [state, setState] = useState<AuthState>({
    user: null,
    session: null,
    loading: true,
  });

  useEffect(() => {
    const supabase = createClient();

    const getInitialSession = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      setState({
        user: session?.user ?? null,
        session,
        loading: false,
      });
    };

    getInitialSession();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setState({
        user: session?.user ?? null,
        session,
        loading: false,
      });
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  return (
    <SupabaseAuthContext.Provider value={state}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </SupabaseAuthContext.Provider>
  );
}

// NextAuth compatibility hook
export function useAuth() {
  const context = useContext(SupabaseAuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within a SupabaseAuthContext.Provider");
  }

  return {
    data: context.session
      ? {
          user: {
            email: context.session.user.email,
            id: context.session.user.id,
          },
        }
      : null,
    status: context.loading
      ? "loading"
      : context.session
      ? "authenticated"
      : "unauthenticated",
  };
}
