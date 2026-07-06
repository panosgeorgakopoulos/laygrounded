"use client";

import { useState } from "react";
import { EventTypeEnum, EVENT_TYPE_VALUES } from "@/lib/laytime/types";

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
    <div className="h-full flex flex-col">
      <div className="border-b border-[#1f2937] px-4 py-2 flex items-center justify-between">
        <div
          className="text-xs uppercase tracking-wider text-[#9ca3af]"
          style={{ fontFamily: "var(--font-jetbrains-mono)" }}
        >
          EVENT TIMELINE
          <span className="ml-2 text-[#6b7280]">({events.length})</span>
        </div>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="text-xs text-[#f59e0b] hover:underline"
          style={{ fontFamily: "var(--font-jetbrains-mono)" }}
        >
          + ADD EVENT
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {extractionPending && events.length === 0 ? (
          <div className="p-4 space-y-2">
            {[1, 2, 3, 4, 5].map((i) => (
              <div
                key={i}
                className="skeleton-row"
                style={{ height: 56, borderRadius: 2 }}
              />
            ))}
            <div
              className="text-xs text-[#9ca3af] text-center pt-4"
              style={{ fontFamily: "var(--font-jetbrains-mono)" }}
            >
              EXTRACTION IN PROGRESS…
            </div>
          </div>
        ) : events.length === 0 ? (
          <div className="p-8 text-center text-sm text-[#9ca3af]">
            No events yet. Upload a document or add events manually.
          </div>
        ) : (
          <div className="divide-y divide-[#1f2937]">
            {events.map((ev) => {
              const rejected = ev.status === "rejected";
              const selected = ev.id === selectedId;
              return (
                <div
                  key={ev.id}
                  onClick={() => onSelect(ev.id)}
                  className={`p-3 cursor-pointer transition ${
                    selected ? "bg-[#1f2937]" : "hover:bg-[#111827]"
                  } ${rejected ? "opacity-40" : ""}`}
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <span
                      className="text-xs tnum text-[#f9fafb]"
                      style={{ fontFamily: "var(--font-jetbrains-mono)" }}
                    >
                      {new Date(ev.occurredAt).toISOString().slice(0, 16).replace("T", " ")}
                    </span>
                    <span
                      className="status-badge px-1.5 py-0.5"
                      style={{
                        color: eventTypeColor(ev.eventType),
                        background: `${eventTypeColor(ev.eventType)}10`,
                        border: `1px solid ${eventTypeColor(ev.eventType)}40`,
                        borderRadius: 2,
                      }}
                    >
                      {ev.eventType.replace(/_/g, " ")}
                    </span>
                    <span
                      className="ml-auto text-[10px] uppercase tracking-wider"
                      style={{
                        fontFamily: "var(--font-jetbrains-mono)",
                        color: ev.source === "ai" ? "#9ca3af" : "#14b8a6",
                      }}
                    >
                      {ev.source}
                    </span>
                    <span
                      className="text-[10px] uppercase tracking-wider"
                      style={{
                        fontFamily: "var(--font-jetbrains-mono)",
                        color: statusColor(ev.status),
                      }}
                    >
                      {ev.status}
                    </span>
                  </div>

                  {editingId === ev.id ? (
                    <div className="space-y-2 mb-2">
                      <input
                        type="datetime-local"
                        value={editOccurredAt}
                        onChange={(e) => setEditOccurredAt(e.target.value)}
                        className="w-full bg-[#0a0f1e] border border-[#1f2937] px-2 py-1 text-xs text-[#f9fafb]"
                        style={{ borderRadius: 2, fontFamily: "var(--font-jetbrains-mono)" }}
                      />
                      <select
                        value={editEventType}
                        onChange={(e) => setEditEventType(e.target.value)}
                        className="w-full bg-[#0a0f1e] border border-[#1f2937] px-2 py-1 text-xs text-[#f9fafb]"
                        style={{ borderRadius: 2, fontFamily: "var(--font-jetbrains-mono)" }}
                      >
                        {EVENT_TYPE_VALUES.map((t) => (
                          <option key={t} value={t}>
                            {t.replace(/_/g, " ")}
                          </option>
                        ))}
                      </select>
                      <div className="flex gap-2">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            saveEdit();
                          }}
                          className="px-2 py-0.5 text-[10px] text-[#0a0f1e] font-medium"
                          style={{ background: "#f59e0b", borderRadius: 2 }}
                        >
                          SAVE
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingId(null);
                          }}
                          className="px-2 py-0.5 text-[10px] text-[#9ca3af]"
                        >
                          CANCEL
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="text-sm text-[#f9fafb] mb-1.5">{ev.rawText}</div>
                  )}

                  <div className="flex items-center gap-3">
                    {ev.source === "ai" && (
                      <div className="flex items-center gap-1.5">
                        <div className="confidence-bar">
                          <span style={{ width: `${ev.confidence * 100}%` }} />
                        </div>
                        <span
                          className="text-[10px] text-[#6b7280] tnum"
                          style={{ fontFamily: "var(--font-jetbrains-mono)" }}
                        >
                          {(ev.confidence * 100).toFixed(0)}%
                        </span>
                      </div>
                    )}
                    <span
                      className="text-[10px] text-[#6b7280]"
                      style={{ fontFamily: "var(--font-jetbrains-mono)" }}
                    >
                      p.{ev.page}
                    </span>

                    {editingId !== ev.id && (
                      <div className="ml-auto flex items-center gap-1">
                        {ev.status !== "accepted" && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onAccept(ev.id);
                            }}
                            className="px-1.5 py-0.5 text-[10px] text-[#14b8a6] hover:underline"
                            style={{ fontFamily: "var(--font-jetbrains-mono)" }}
                          >
                            ACCEPT
                          </button>
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            startEdit(ev);
                          }}
                          className="px-1.5 py-0.5 text-[10px] text-[#9ca3af] hover:text-[#f9fafb]"
                          style={{ fontFamily: "var(--font-jetbrains-mono)" }}
                        >
                          EDIT
                        </button>
                        {ev.status !== "rejected" && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onReject(ev.id);
                            }}
                            className="px-1.5 py-0.5 text-[10px] text-[#9ca3af] hover:text-[#ef4444]"
                            style={{ fontFamily: "var(--font-jetbrains-mono)" }}
                          >
                            REJECT
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  {ev.aiReasoning && (
                    <div
                      className="mt-1.5 text-xs text-[#6b7280] italic"
                      style={{ fontFamily: "var(--font-jetbrains-mono)" }}
                    >
                      → {ev.aiReasoning}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {showAdd && (
          <div className="border-t border-[#1f2937] p-4 bg-[#111827] space-y-2">
            <div
              className="text-xs uppercase tracking-wider text-[#f59e0b]"
              style={{ fontFamily: "var(--font-jetbrains-mono)" }}
            >
              ADD EVENT MANUALLY
            </div>
            <input
              type="datetime-local"
              value={newOccurredAt}
              onChange={(e) => setNewOccurredAt(e.target.value)}
              className="w-full bg-[#0a0f1e] border border-[#1f2937] px-2 py-1.5 text-xs text-[#f9fafb]"
              style={{ borderRadius: 2, fontFamily: "var(--font-jetbrains-mono)" }}
            />
            <select
              value={newEventType}
              onChange={(e) => setNewEventType(e.target.value)}
              className="w-full bg-[#0a0f1e] border border-[#1f2937] px-2 py-1.5 text-xs text-[#f9fafb]"
              style={{ borderRadius: 2, fontFamily: "var(--font-jetbrains-mono)" }}
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
              className="w-full bg-[#0a0f1e] border border-[#1f2937] px-2 py-1.5 text-xs text-[#f9fafb]"
              style={{ borderRadius: 2 }}
            />
            <div className="flex gap-2">
              <button
                onClick={submitAdd}
                className="px-2 py-1 text-[10px] text-[#0a0f1e] font-medium"
                style={{ background: "#f59e0b", borderRadius: 2 }}
              >
                SAVE EVENT
              </button>
              <button
                onClick={() => setShowAdd(false)}
                className="px-2 py-1 text-[10px] text-[#9ca3af]"
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
  if (t.includes("NOR")) return "#f59e0b";
  if (t.includes("COMMENCED") || t.includes("COMPLETED")) return "#14b8a6";
  if (t.includes("WEATHER")) return "#ef4444";
  if (t.includes("SHIFTING")) return "#92691a";
  return "#9ca3af";
}

function statusColor(s: string): string {
  if (s === "accepted") return "#14b8a6";
  if (s === "edited") return "#f59e0b";
  if (s === "rejected") return "#ef4444";
  return "#9ca3af";
}
