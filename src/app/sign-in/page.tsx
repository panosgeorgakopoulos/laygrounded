import Link from "next/link";
import { SignInForm } from "@/components/laygrounded/sign-in-form";

export const metadata = { title: "Sign In — LayGrounded" };

export default function SignInPage() {
  return (
    <main className="min-h-screen bg-[#0a0f1e] text-[#f9fafb] flex flex-col">
      <header className="border-b border-[#1f2937]">
        <div className="mx-auto max-w-7xl px-6 h-14 flex items-center">
          <Link href="/" className="flex items-center gap-2">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: "#f59e0b" }}
            />
            <span className="font-semibold">LayGrounded</span>
          </Link>
        </div>
      </header>

      <div className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-md">
          <h1
            className="text-3xl font-semibold mb-2"
            style={{ fontFamily: "var(--font-space-grotesk)" }}
          >
            Sign in
          </h1>
          <p className="text-sm text-[#9ca3af] mb-8">
            Access your claim workspace.
          </p>

          <SignInForm />

          <div className="mt-6 text-sm text-[#9ca3af]">
            New to LayGrounded?{" "}
            <Link href="/sign-up" className="text-[#f59e0b] hover:underline">
              Initialize a workspace
            </Link>
          </div>

          <div
            className="mt-8 p-3 border border-[#1f2937] bg-[#111827] text-xs text-[#9ca3af]"
            style={{ borderRadius: 2 }}
          >
            <div
              className="mb-1 uppercase tracking-wider text-[10px] text-[#6b7280]"
              style={{ fontFamily: "var(--font-jetbrains-mono)" }}
            >
              Demo access
            </div>
            <div>
              Email: <span className="text-[#f9fafb]">demo@laygrounded.io</span>
            </div>
            <div>
              Password: <span className="text-[#f9fafb]">demo1234</span>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
