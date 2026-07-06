"use client";

import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

export default function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { data: session, status } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [companyName, setCompanyName] = useState<string>("");
  const [memberEmail, setMemberEmail] = useState<string>("");

  useEffect(() => {
    if (status === "loading") return;
    if (!session?.user) {
      router.push("/sign-in");
      return;
    }
    fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.company?.name) setCompanyName(d.company.name);
        if (d?.members) {
          const me = d.members.find(
            (m: { email: string }) => m.email === session.user?.email
          );
          if (me) setMemberEmail(me.email);
        }
      })
      .catch(() => {});
  }, [session, status, router]);

  // userEmail is derived from session.user.email directly — no setState needed.
  const userEmailFromSession = memberEmail || session?.user?.email || "";

  if (status === "loading") {
    return (
      <div className="min-h-screen bg-[#0a0f1e] text-[#f9fafb] flex items-center justify-center">
        <div
          className="text-sm text-[#9ca3af]"
          style={{ fontFamily: "var(--font-jetbrains-mono)" }}
        >
          AUTHENTICATING…
        </div>
      </div>
    );
  }
  if (!session?.user) return null;

  const navItems = [
    { href: "/claims", label: "Claims" },
    { href: "/claims/new", label: "New Claim" },
    { href: "/settings", label: "Settings" },
  ];

  const isActive = (href: string) => {
    if (href === "/claims")
      return pathname === "/claims" || pathname.startsWith("/claims/");
    return pathname === href;
  };

  return (
    <div className="min-h-screen bg-[#0a0f1e] text-[#f9fafb] flex">
      <aside
        className="fixed inset-y-0 left-0 w-60 border-r border-[#1f2937] bg-[#0a0f1e] flex flex-col"
        style={{ zIndex: 30 }}
      >
        <div className="h-14 flex items-center px-5 border-b border-[#1f2937]">
          <Link href="/" className="flex items-center gap-2">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: "#f59e0b" }}
            />
            <span
              className="font-semibold tracking-tight"
              style={{ fontFamily: "var(--font-space-grotesk)" }}
            >
              LayGrounded
            </span>
          </Link>
        </div>

        <nav className="flex-1 py-4">
          {navItems.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`block px-5 py-2.5 text-sm transition ${
                  active
                    ? "sidebar-item-active text-[#f9fafb]"
                    : "sidebar-item text-[#9ca3af] hover:text-[#f9fafb] hover:bg-[#111827]"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-[#1f2937] p-4">
          <div
            className="text-xs text-[#6b7280] uppercase tracking-wider"
            style={{ fontFamily: "var(--font-jetbrains-mono)" }}
          >
            Company
          </div>
          <div className="mt-1 text-sm text-[#f9fafb] truncate">
            {companyName || "—"}
          </div>
          <div
            className="mt-3 text-xs text-[#6b7280] uppercase tracking-wider"
            style={{ fontFamily: "var(--font-jetbrains-mono)" }}
          >
            User
          </div>
          <div className="mt-1 text-sm text-[#f9fafb] truncate">
            {userEmailFromSession}
          </div>
        </div>
      </aside>

      <div className="flex-1 ml-60 min-w-0">{children}</div>
    </div>
  );
}
