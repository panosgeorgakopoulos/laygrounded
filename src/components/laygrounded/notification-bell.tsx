"use client";

// The bell, and the shared list the inbox page also renders.
//
// POLLED, NOT PUSHED. Supabase Realtime would deliver these instantly and is a
// standing websocket per signed-in tab plus a subscription that has to be torn
// down correctly on every route change. Nothing here is time-critical to the
// second — the fastest of these facts (a claim was agreed) is minutes old by
// the time a human acts on it — so a 60s poll buys the whole feature at a
// fraction of the moving parts. If a use case ever needs sub-second delivery,
// that is the moment to add the socket, not before.
//
// The count comes from a COUNT query rather than from the length of the list,
// so a badge showing 30 when there are 200 unread cannot happen.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Bell, Check, CheckCheck, Inbox, X } from "lucide-react";
import styles from "./NotificationBell.module.css";

export interface NotificationItem {
  id: string;
  kind: string;
  severity: "info" | "action" | "urgent";
  title: string;
  body: string;
  href: string | null;
  subjectType: string | null;
  subjectId: string | null;
  readAt: string | null;
  dismissedAt: string | null;
  createdAt: string;
}

const POLL_MS = 60_000;

/** Relative time, without pulling in a formatter for six cases. */
export function ago(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

export function useNotifications(includeDismissed = false) {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/notifications?limit=50${includeDismissed ? "&include=all" : ""}`
      );
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      setItems(body.notifications as NotificationItem[]);
      setUnread(body.unreadCount as number);
    } catch {
      // Signed out, offline, or a transient failure. Leaving the previous list
      // in place beats blanking the panel — a bell that empties itself on a
      // flaky connection looks like the alerts were withdrawn.
    } finally {
      setLoading(false);
    }
  }, [includeDismissed]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const mutate = useCallback(
    async (action: "read" | "unread" | "dismiss", opts: { ids?: string[]; all?: boolean }) => {
      await fetch("/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...opts }),
      });
      await load();
    },
    [load]
  );

  return { items, unread, loading, reload: load, mutate };
}

export function NotificationList({
  items,
  loading,
  onRead,
  onDismiss,
  emptyHint,
}: {
  items: NotificationItem[];
  loading: boolean;
  onRead: (id: string) => void;
  onDismiss: (id: string) => void;
  emptyHint: string;
}) {
  const router = useRouter();

  if (loading && items.length === 0) {
    return <p className={styles.empty}>Loading…</p>;
  }
  if (items.length === 0) {
    return (
      <p className={styles.empty}>
        <Inbox size={15} /> {emptyHint}
      </p>
    );
  }

  return (
    <ul className={styles.list}>
      {items.map((n) => {
        const unread = !n.readAt;
        return (
          <li
            key={n.id}
            className={`${styles.item} ${unread ? styles.unread : ""} ${styles[n.severity] ?? ""}`}
          >
            {/* A button rather than a bare <a>: clicking must both navigate AND
                mark read, and an anchor that also mutates state has to fight
                the browser for the ordering. */}
            <button
              type="button"
              className={styles.itemBody}
              onClick={() => {
                onRead(n.id);
                if (n.href) router.push(n.href);
              }}
            >
              <span className={styles.itemHead}>
                {n.severity === "urgent" && (
                  <AlertTriangle size={13} className={styles.urgentIcon} aria-hidden />
                )}
                <span className={styles.itemTitle}>{n.title}</span>
                <time className={styles.time} dateTime={n.createdAt}>
                  {ago(n.createdAt)}
                </time>
              </span>
              <span className={styles.itemText}>{n.body}</span>
            </button>
            <div className={styles.itemActions}>
              {unread && (
                <button
                  type="button"
                  className={styles.iconBtn}
                  title="Mark as read"
                  aria-label={`Mark "${n.title}" as read`}
                  onClick={() => onRead(n.id)}
                >
                  <Check size={14} />
                </button>
              )}
              <button
                type="button"
                className={styles.iconBtn}
                title="Dismiss"
                aria-label={`Dismiss "${n.title}"`}
                onClick={() => onDismiss(n.id)}
              >
                <X size={14} />
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const { items, unread, loading, mutate } = useNotifications();
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close on outside click and on Escape. Both, because a dropdown that traps
  // focus with no keyboard exit is unusable without a mouse.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const visible = items.filter((n) => !n.dismissedAt).slice(0, 8);

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        type="button"
        className={styles.bell}
        onClick={() => setOpen((o) => !o)}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <Bell size={17} />
        {unread > 0 && (
          <span className={styles.badge} aria-hidden>
            {/* Capped for layout, and the label above still says the real
                number for a screen reader. */}
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className={styles.panel} role="dialog" aria-label="Notifications">
          <header className={styles.panelHead}>
            <strong>Notifications</strong>
            {unread > 0 && (
              <button
                type="button"
                className={styles.textBtn}
                onClick={() => void mutate("read", { all: true })}
              >
                <CheckCheck size={13} /> Mark all read
              </button>
            )}
          </header>

          <NotificationList
            items={visible}
            loading={loading}
            onRead={(id) => void mutate("read", { ids: [id] })}
            onDismiss={(id) => void mutate("dismiss", { ids: [id] })}
            emptyHint="Nothing needs your attention."
          />

          <footer className={styles.panelFoot}>
            <Link href="/notifications" onClick={() => setOpen(false)}>
              Open inbox
            </Link>
          </footer>
        </div>
      )}
    </div>
  );
}
