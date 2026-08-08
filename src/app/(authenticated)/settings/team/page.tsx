import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { TeamManagement } from "@/components/laygrounded/team-management";
import styles from "../Settings.module.css";

export const metadata: Metadata = {
  title: "Team · LayGrounded",
  description: "Who is in your company, and what each of them is allowed to do.",
};

// A page of its own rather than a tab inside /settings.
//
// Roles are the answer to "why can't I click this?", which is a question asked
// from somewhere else in the product — usually by someone who has just been
// refused. That needs a URL a colleague can paste, and the deep link is also
// where the workspace panels point when they explain a disabled control.
export default function TeamSettingsPage() {
  return (
    <div className={styles.pageContainer}>
      <div className={styles.header}>
        <Link href="/settings" className={styles.subtitle}>
          <ChevronLeft size={14} style={{ verticalAlign: "-2px" }} /> Settings
        </Link>
        <h1 className={styles.title}>Team</h1>
        <p className={styles.subtitle}>
          Who belongs to this company, and what each of them may do. Roles are enforced on every
          request, not just hidden in the interface.
        </p>
      </div>
      <TeamManagement />
    </div>
  );
}
