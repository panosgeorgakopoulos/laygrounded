"use client";

import { useState } from "react";
import { EventTypeEnum, EVENT_TYPE_VALUES } from "@/lib/laytime/types";
import styles from "./EventTimeline.module.css";
import { Button } from "@/components/core/Button";

export interface SofEvent {
  id: string;
  occurredAt: string;
  eventType: string;
  rawText: string;
  page: number;
  bbox: { x: number; y: number; width: number; height: number };
  confidence: number;
  source: string;
  status: string;
  aiReasoning: string | null;
}

interface EventTimelineProps {
  events: SofEvent[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onEdit: (id: string, occurredAt: string, eventType: string) => void;
  onAdd: (occurredAt: string, eventType: string, rawText: string) => void;
  extractionPending: boolean;
}

export function EventTimeline({
  events,
  selectedId,
  onSelect,
  onAccept,
  onReject,
  onEdit,
  onAdd,
  extractionPending,
}: EventTimelineProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editOccurredAt, setEditOccurredAt] = useState("");
  const [editEventType, setEditEventType] = useState<string>("");
  const [showAdd, setShowAdd] = useState(false);
  const [newOccurredAt, setNewOccurredAt] = useState("");
  const [newEventType, setNewEventType] = useState<string>("NOR_TENDERED");
  const [newRawText, setNewRawText] = useState("");

  function startEdit(ev: SofEvent) {
    setEditingId(ev.id);
    // Format datetime-local input.
    const dt = new Date(ev.occurredAt);
    const offset = dt.getTimezoneOffset();
    const local = new Date(dt.getTime() - offset * 60000);
    setEditOccurredAt(local.toISOString().slice(0, 16));
    setEditEventType(ev.eventType);
  }
  function saveEdit() {
    if (!editingId) return;
    const iso = new Date(editOccurredAt).toISOString();
    onEdit(editingId, iso, editEventType);
    setEditingId(null);
  }

  function submitAdd() {
    if (!newOccurredAt) return;
    const iso = new Date(newOccurredAt).toISOString();
    onAdd(iso, newEventType, newRawText);
    setShowAdd(false);
    setNewOccurredAt("");
    setNewEventType("NOR_TENDERED");
    setNewRawText("");
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={`${styles.headerTitle} tnum`}>
          EVENT TIMELINE
          <span className={styles.headerCount}>({events.length})</span>
        </div>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className={`${styles.addBtn} tnum`}
        >
          + ADD EVENT
        </button>
      </div>

      <div className={styles.scrollArea}>
        {extractionPending && events.length === 0 ? (
          <div className={styles.skeletonContainer}>
            {[1, 2, 3, 4, 5].map((i) => (
              <div
                key={i}
                className={styles.skeletonRow}
              />
            ))}
            <div className={`${styles.extractionText} tnum`}>
              EXTRACTION IN PROGRESS…
            </div>
          </div>
        ) : events.length === 0 ? (
          <div className={styles.emptyState}>
            No events yet. Upload a document or add events manually.
          </div>
        ) : (
          <div className={styles.eventList}>
            {events.map((ev) => {
              const rejected = ev.status === "rejected";
              const selected = ev.id === selectedId;
              return (
                <div
                  key={ev.id}
                  onClick={() => onSelect(ev.id)}
                  className={`${styles.eventItem} ${selected ? styles.eventItemSelect : styles.eventItemHover} ${rejected ? styles.eventItemReject : ""}`}
                >
                  <div className={styles.eventTopRow}>
                    <span className={`${styles.eventTime} tnum`}>
                      {new Date(ev.occurredAt).toISOString().slice(0, 16).replace("T", " ")}
                    </span>
                    <span
                      className={styles.eventTypeBadge}
                      style={{
                        color: eventTypeColor(ev.eventType),
                        backgroundColor: `${eventTypeColor(ev.eventType)}15`,
                        borderColor: `${eventTypeColor(ev.eventType)}40`,
                      }}
                    >
                      {ev.eventType.replace(/_/g, " ")}
                    </span>
                    <span
                      className={styles.eventSource}
                      style={{ color: ev.source === "ai" ? "var(--color-text-tertiary)" : "var(--color-primary)" }}
                    >
                      {ev.source}
                    </span>
                    <span
                      className={styles.eventStatus}
                      style={{ color: statusColor(ev.status) }}
                    >
                      {ev.status}
                    </span>
                  </div>

                  {editingId === ev.id ? (
                    <div className={styles.editForm}>
                      <input
                        type="datetime-local"
                        value={editOccurredAt}
                        onChange={(e) => setEditOccurredAt(e.target.value)}
                        className={`${styles.inputField} tnum`}
                      />
                      <select
                        value={editEventType}
                        onChange={(e) => setEditEventType(e.target.value)}
                        className={`${styles.inputField} tnum`}
                      >
                        {EVENT_TYPE_VALUES.map((t) => (
                          <option key={t} value={t}>
                            {t.replace(/_/g, " ")}
                          </option>
                        ))}
                      </select>
                      <div className={styles.editActions}>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            saveEdit();
                          }}
                          className={styles.actionBtnPrimary}
                        >
                          SAVE
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingId(null);
                          }}
                          className={styles.actionBtnSecondary}
                        >
                          CANCEL
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className={styles.eventRawText}>{ev.rawText}</div>
                  )}

                  <div className={styles.eventBottomRow}>
                    {ev.source === "ai" && (
                      <div className={styles.confidenceWrapper}>
                        <div className={styles.confidenceBarBg}>
                          <div
                            className={styles.confidenceBarFill}
                            style={{ width: `${ev.confidence * 100}%` }}
                          />
                        </div>
                        <span className={`${styles.confidenceText} tnum`}>
                          {(ev.confidence * 100).toFixed(0)}%
                        </span>
                      </div>
                    )}
                    <span className={`${styles.pageText} tnum`}>
                      p.{ev.page}
                    </span>

                    {editingId !== ev.id && (
                      <div className={styles.eventItemActions}>
                        {ev.status !== "accepted" && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onAccept(ev.id);
                            }}
                            className={`${styles.actionBtnLink} ${styles.actionBtnAccept} tnum`}
                          >
                            ACCEPT
                          </button>
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            startEdit(ev);
                          }}
                          className={`${styles.actionBtnLink} tnum`}
                        >
                          EDIT
                        </button>
                        {ev.status !== "rejected" && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onReject(ev.id);
                            }}
                            className={`${styles.actionBtnLink} ${styles.actionBtnReject} tnum`}
                          >
                            REJECT
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  {ev.aiReasoning && (
                    <div className={`${styles.aiReasoning} tnum`}>
                      → {ev.aiReasoning}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {showAdd && (
          <div className={styles.addFormContainer}>
            <div className={`${styles.addFormTitle} tnum`}>
              ADD EVENT MANUALLY
            </div>
            <input
              type="datetime-local"
              value={newOccurredAt}
              onChange={(e) => setNewOccurredAt(e.target.value)}
              className={`${styles.inputField} tnum`}
            />
            <select
              value={newEventType}
              onChange={(e) => setNewEventType(e.target.value)}
              className={`${styles.inputField} tnum`}
            >
              {EVENT_TYPE_VALUES.map((t) => (
                <option key={t} value={t}>
                  {t.replace(/_/g, " ")}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={newRawText}
              onChange={(e) => setNewRawText(e.target.value)}
              placeholder="Verbatim text (optional)"
              className={styles.inputField}
            />
            <div className={styles.addFormActions}>
              <button
                onClick={submitAdd}
                className={styles.actionBtnPrimary}
              >
                SAVE EVENT
              </button>
              <button
                onClick={() => setShowAdd(false)}
                className={styles.actionBtnSecondary}
              >
                CANCEL
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function eventTypeColor(t: string): string {
  if (t.includes("NOR")) return "#c2410c"; // Darker orange
  if (t.includes("COMMENCED") || t.includes("COMPLETED")) return "#0f766e"; // Teal
  if (t.includes("WEATHER")) return "#b91c1c"; // Red
  if (t.includes("SHIFTING")) return "#854d0e"; // Yellow/Brown
  return "var(--color-text-tertiary)";
}

function statusColor(s: string): string {
  if (s === "accepted") return "#0f766e";
  if (s === "edited") return "#c2410c";
  if (s === "rejected") return "#b91c1c";
  return "var(--color-text-tertiary)";
}
