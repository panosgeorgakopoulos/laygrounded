import Link from "next/link";
import { SignUpForm } from "@/components/laygrounded/sign-up-form";

export const metadata = { title: "Sign Up — LayGrounded" };

export default function SignUpPage() {
  return (
    <main className="min-h-screen bg-[#0a0f1e] text-[#f9fafb] flex flex-col">
      <header className="border-b border-[#1f2937]">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 h-14 flex items-center">
          <Link href="/" className="flex items-center gap-2">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: "#f59e0b" }}
            />
            <span className="font-semibold">LayGrounded</span>
          </Link>
        </div>
      </header>

      <div className="flex-1 flex items-center justify-center px-4 sm:px-6 py-12">
        <div className="w-full max-w-md mx-auto">
          <h1
            className="text-3xl font-semibold mb-2"
            style={{ fontFamily: "var(--font-space-grotesk)" }}
          >
            Initialize your workspace
          </h1>
          <p className="text-sm text-[#9ca3af] mb-8">
            Create a company and start arbitrating laytime claims.
          </p>

          <SignUpForm />

          <div className="mt-6 text-sm text-[#9ca3af]">
            Already have a workspace?{" "}
            <Link href="/sign-in" className="text-[#f59e0b] hover:underline">
              Sign in
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
