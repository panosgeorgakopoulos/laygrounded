"use client";

// The full inbox. The bell dropdown shows the most recent eight; this shows
// everything, including what has been dismissed — because "did anyone tell me
// about this?" is a question people ask after the fact, and an inbox that
// cannot answer it is an inbox they stop trusting.

import { useState } from "react";
import { CheckCheck, Inbox } from "lucide-react";
import {
  NotificationList,
  useNotifications,
} from "@/components/laygrounded/notification-bell";
import styles from "./Notifications.module.css";

export default function NotificationsPage() {
  const [showDismissed, setShowDismissed] = useState(false);
  const { items, unread, loading, mutate } = useNotifications(showDismissed);

  const visible = showDismissed ? items : items.filter((n) => !n.dismissedAt);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>
          <Inbox size={20} /> Inbox
        </h1>
        <p className={styles.subtitle}>
          What needs your attention. You see an alert when your role means you could act on it —
          agreeing a claim, reviewing a settlement, re-planning a voyage.
          {unread > 0 && <> You have <strong>{unread}</strong> unread.</>}
        </p>
      </header>

      <div className={styles.toolbar}>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={showDismissed}
            onChange={(e) => setShowDismissed(e.target.checked)}
          />
          Show dismissed
        </label>
        {unread > 0 && (
          <button
            type="button"
            className={styles.markAll}
            onClick={() => void mutate("read", { all: true })}
          >
            <CheckCheck size={14} /> Mark all read
          </button>
        )}
      </div>

      <div className={styles.panel}>
        <NotificationList
          items={visible}
          loading={loading}
          onRead={(id) => void mutate("read", { ids: [id] })}
          onDismiss={(id) => void mutate("dismiss", { ids: [id] })}
          emptyHint={
            showDismissed
              ? "Nothing here yet."
              : "Nothing needs your attention. Dismissed alerts are still available above."
          }
        />
      </div>
    </div>
  );
}
