"use client";

import { use, useEffect, useState, useCallback, useRef } from "react";
import { DocumentViewer } from "@/components/laygrounded/document-viewer";
import { EventTimeline, SofEvent } from "@/components/laygrounded/event-timeline";
import { CalculationPane } from "@/components/laygrounded/calculation-pane";
import { CpTerms, LaytimeResult } from "@/lib/laytime/types";
import { DownloadIcon } from "@/components/laygrounded/nav-icons";
import styles from "./Workspace.module.css";
import { Button } from "@/components/core/Button";

interface ClauseFlag {
  id: string;
  eventId: string;
  clauseRef: string;
  severity: "info" | "warning" | "critical";
  note: string;
  createdAt: string;
}

interface ClaimData {
  claim: {
    id: string;
    vessel: string;
    voyageRef: string;
    port: string;
    cargo: string;
    cpForm: string;
    cpTerms: string | null;
    status: string;
    updatedAt: string;
    documents: Array<{
      id: string;
      storagePath: string;
      mime: string;
      originalFilename: string;
      extractionStatus: string;
      pageCount: number | null;
    }>;
    sofEvents: SofEvent[];
    calculations: Array<{
      breakdown: string;
      usedHours: number;
      allowedHours: number;
      demurrageAmount: number | null;
      despatchAmount: number | null;
      currency: string;
    }>;
  };
  clauseFlags: ClauseFlag[];
}

export default function WorkspacePage({
  params,
}: {
  params: Promise<{ claimId: string }>;
}) {
  const { claimId } = use(params);
  const [data, setData] = useState<ClaimData | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [cpTerms, setCpTerms] = useState<CpTerms | null>(null);
  const [result, setResult] = useState<LaytimeResult | null>(null);
  const [clauseFlags, setClauseFlags] = useState<ClauseFlag[]>([]);
  const [exporting, setExporting] = useState(false);
  const [flagging, setFlagging] = useState(false);
  const [activeTab, setActiveTab] = useState<"document" | "events" | "calculation">("document");
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  const fetchClaim = useCallback(async () => {
    const res = await fetch(`/api/claims/${claimId}`);
    if (!res.ok) return;
    const d: ClaimData = await res.json();
    setData(d);
    const cp = d.claim.cpTerms ? JSON.parse(d.claim.cpTerms) : null;
    setCpTerms(cp);
    setClauseFlags(d.clauseFlags);
    // Build result from latest calculation.
    if (d.claim.calculations[0]) {
      const calc = d.claim.calculations[0];
      const breakdown = JSON.parse(calc.breakdown);
      setResult({
        breakdown,
        totals: {
          allowed_hours: calc.allowedHours,
          used_hours: calc.usedHours,
          time_on_demurrage_hours: Math.max(0, calc.usedHours - calc.allowedHours),
          time_saved_hours: Math.max(0, calc.allowedHours - calc.usedHours),
          demurrage_amount: calc.demurrageAmount ?? 0,
          despatch_amount: calc.despatchAmount ?? 0,
          currency: calc.currency,
        },
      });
    } else {
      setResult(null);
    }
    // If extraction in progress, poll.
    const doc = d.claim.documents[0];
    if (doc && doc.extractionStatus === "extracting") {
      if (pollRef.current) clearTimeout(pollRef.current);
      pollRef.current = setTimeout(fetchClaim, 2500);
    }
  }, [claimId]);

  useEffect(() => {
    fetchClaim().finally(() => setLoading(false));
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [fetchClaim]);

  // Recompute helper.
  const recompute = useCallback(async () => {
    const res = await fetch(`/api/claims/${claimId}/recompute`, { method: "POST" });
    if (res.ok) {
      const d = await res.json();
      setResult(d.result);
    } else {
      setResult(null);
    }
  }, [claimId]);

  const refreshEvents = useCallback(async () => {
    const res = await fetch(`/api/claims/${claimId}/events`);
    if (res.ok) {
      const d = await res.json();
      // Update data's events.
      setData((prev) =>
        prev ? { ...prev, claim: { ...prev.claim, sofEvents: d.events } } : prev
      );
    }
  }, [claimId]);

  // Upload handler.
  const onUpload = useCallback(
    async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`/api/claims/${claimId}/documents`, {
        method: "POST",
        body: formData,
      });
      if (res.ok) {
        // Wait briefly then re-fetch (extraction runs async).
        setTimeout(fetchClaim, 800);
      }
    },
    [claimId, fetchClaim]
  );

  const onReplace = useCallback(async () => {
    if (!data?.claim.documents[0]) return;
    if (!confirm("Replace document? All current events will be marked rejected and re-extracted.")) return;
    await fetch(`/api/claims/${claimId}/documents/${data.claim.documents[0].id}`, {
      method: "DELETE",
    });
    setTimeout(fetchClaim, 800);
  }, [claimId, data, fetchClaim]);

  // Event actions.
  const onAccept = useCallback(
    async (id: string) => {
      await fetch(`/api/claims/${claimId}/events/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "accepted" }),
      });
      await refreshEvents();
      await recompute();
    },
    [claimId, refreshEvents, recompute]
  );

  const onReject = useCallback(
    async (id: string) => {
      await fetch(`/api/claims/${claimId}/events/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "rejected" }),
      });
      await refreshEvents();
      await recompute();
    },
    [claimId, refreshEvents, recompute]
  );

  const onEdit = useCallback(
    async (id: string, occurredAt: string, eventType: string) => {
      await fetch(`/api/claims/${claimId}/events/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ occurredAt, eventType, status: "edited" }),
      });
      await refreshEvents();
      await recompute();
    },
    [claimId, refreshEvents, recompute]
  );

  const onAdd = useCallback(
    async (occurredAt: string, eventType: string, rawText: string) => {
      await fetch(`/api/claims/${claimId}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ occurredAt, eventType, rawText }),
      });
      await refreshEvents();
      await recompute();
    },
    [claimId, refreshEvents, recompute]
  );

  // CP terms change.
  const onCpTermsChange = useCallback(
    async (newCp: CpTerms) => {
      setCpTerms(newCp);
      await fetch(`/api/claims/${claimId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cpTerms: newCp }),
      });
      await recompute();
    },
    [claimId, recompute]
  );

  // Clause analysis.
  const onRunClauseAnalysis = useCallback(async () => {
    setFlagging(true);
    try {
      const res = await fetch(`/api/claims/${claimId}/flag-clauses`, {
        method: "POST",
      });
      if (res.ok) {
        const d = await res.json();
        setClauseFlags(d.flags || []);
      }
    } finally {
      setFlagging(false);
    }
  }, [claimId]);

  // Export.
  const onExport = useCallback(async () => {
    setExporting(true);
    try {
      const res = await fetch(`/api/claims/${claimId}/export`, {
        method: "POST",
      });
      if (res.ok) {
        const d = await res.json();
        // Open PDF in new tab.
        if (d.pdfUrl) window.open(d.pdfUrl, "_blank");
        if (d.xlsxUrl) window.open(d.xlsxUrl, "_blank");
      }
    } finally {
      setExporting(false);
    }
  }, [claimId]);

  // Compute highlighted bbox.
  const selectedEvent = data?.claim.sofEvents.find((e) => e.id === selectedEventId);
  const highlightedBbox = selectedEvent
    ? typeof selectedEvent.bbox === "string"
      ? JSON.parse(selectedEvent.bbox as any)
      : selectedEvent.bbox
    : null;
  const highlightedPage = selectedEvent?.page ?? null;

  if (loading) {
    return (
      <div className={styles.centeredState}>
        <span className="tnum">LOADING WORKSPACE…</span>
      </div>
    );
  }

  if (!data || !cpTerms) {
    return (
      <div className={styles.centeredState}>
        Claim not found.
      </div>
    );
  }

  const doc = data.claim.documents[0];
  const docUrl = doc ? `/uploads/${doc.storagePath}` : null;
  const extractionPending = doc?.extractionStatus === "extracting";

  return (
    <div className={styles.workspaceContainer}>
      {/* Header */}
      <header className={styles.header}>
        {/* Desktop header */}
        <div className={styles.headerDesktop}>
          <div className={styles.headerInfo}>
            <div className={styles.infoItem}>
              <span className={styles.infoLabel}>Vessel:</span>
              <span className={styles.infoValue}>{data.claim.vessel}</span>
            </div>
            <div className={styles.infoItem}>
              <span className={styles.infoLabel}>Voyage:</span>
              <span className={`${styles.infoValueTnum} tnum`}>
                {data.claim.voyageRef}
              </span>
            </div>
            <div className={styles.infoItem}>
              <span className={styles.infoLabel}>Port:</span>
              <span className={styles.infoValue}>{data.claim.port}</span>
            </div>
            <div className={styles.infoItem}>
              <span
                className={`${styles.statusBadge} ${
                  data.claim.status === "demurrage" ? styles.statusDemurrage :
                  data.claim.status === "despatch" ? styles.statusDespatch :
                  styles.statusDefault
                }`}
              >
                {data.claim.status.replace(/_/g, " ")}
              </span>
            </div>
            <div className={styles.infoItem}>
              <span className={`${styles.updatedAt} tnum`}>
                UPDATED {new Date(data.claim.updatedAt).toISOString().slice(0, 16).replace("T", " ")}
              </span>
            </div>
          </div>
          <Button onClick={onExport} disabled={exporting} isLoading={exporting}>
            EXPORT
          </Button>
        </div>

        {/* Mobile header */}
        <div className={styles.headerMobile}>
          <div className={styles.mobileHeaderTop}>
            <div className={styles.mobileHeaderMain}>
              <div className={styles.mobileHeaderTitle}>
                <span className={styles.mobileTitleText}>{data.claim.vessel}</span>
                <span className={`${styles.mobileTitleVoyage} tnum`}>
                  {data.claim.voyageRef}
                </span>
              </div>
              <div className={styles.mobileHeaderSub}>
                <span className={styles.mobileSubText}>{data.claim.port}</span>
                <span
                  className={`${styles.statusBadge} ${
                    data.claim.status === "demurrage" ? styles.statusDemurrage :
                    data.claim.status === "despatch" ? styles.statusDespatch :
                    styles.statusDefault
                  }`}
                >
                  {data.claim.status.replace(/_/g, " ")}
                </span>
              </div>
            </div>
            <button
              onClick={onExport}
              disabled={exporting}
              className={styles.exportBtnMobile}
              aria-label={exporting ? "Exporting claim pack" : "Export claim pack"}
            >
              <DownloadIcon />
            </button>
          </div>
        </div>
      </header>

      {/* Mobile tab bar */}
      <div className={styles.mobileTabBar} role="tablist" aria-label="Workspace panes">
        {(["document", "events", "calculation"] as const).map((key) => {
          const active = activeTab === key;
          return (
            <button
              key={key}
              role="tab"
              aria-selected={active}
              onClick={() => setActiveTab(key)}
              className={`${styles.mobileTab} ${active ? styles.mobileTabActive : ""} tnum`}
            >
              {key}
            </button>
          );
        })}
      </div>

      {/* Desktop 3-pane */}
      <div className={styles.mainGrid}>
        <div className={styles.pane}>
          <DocumentViewer
            documentUrl={docUrl}
            mime={doc?.mime ?? null}
            extractionStatus={doc?.extractionStatus ?? "pending"}
            highlightedBbox={highlightedBbox}
            highlightedPage={highlightedPage}
            onUpload={onUpload}
            onReplace={onReplace}
          />
        </div>
        <div className={styles.pane}>
          <EventTimeline
            events={data.claim.sofEvents.map((e: any) => ({
              ...e,
              bbox: typeof e.bbox === "string" ? JSON.parse(e.bbox) : e.bbox,
            }))}
            selectedId={selectedEventId}
            onSelect={setSelectedEventId}
            onAccept={onAccept}
            onReject={onReject}
            onEdit={onEdit}
            onAdd={onAdd}
            extractionPending={extractionPending}
          />
        </div>
        <div className={styles.pane}>
          <CalculationPane
            key={JSON.stringify(cpTerms)}
            claimId={claimId}
            cpTerms={cpTerms}
            onCpTermsChange={onCpTermsChange}
            result={result}
            clauseFlags={clauseFlags}
            onRunClauseAnalysis={onRunClauseAnalysis}
            onExport={onExport}
            exporting={exporting}
            flagging={flagging}
          />
        </div>
      </div>

      {/* Mobile single-pane by tab */}
      <div className={styles.mainMobile}>
        {activeTab === "document" && (
          <DocumentViewer
            documentUrl={docUrl}
            mime={doc?.mime ?? null}
            extractionStatus={doc?.extractionStatus ?? "pending"}
            highlightedBbox={highlightedBbox}
            highlightedPage={highlightedPage}
            onUpload={onUpload}
            onReplace={onReplace}
          />
        )}
        {activeTab === "events" && (
          <EventTimeline
            events={data.claim.sofEvents.map((e: any) => ({
              ...e,
              bbox: typeof e.bbox === "string" ? JSON.parse(e.bbox) : e.bbox,
            }))}
            selectedId={selectedEventId}
            onSelect={(id) => {
              setSelectedEventId(id);
              setActiveTab("document");
            }}
            onAccept={onAccept}
            onReject={onReject}
            onEdit={onEdit}
            onAdd={onAdd}
            extractionPending={extractionPending}
          />
        )}
        {activeTab === "calculation" && (
          <CalculationPane
            key={JSON.stringify(cpTerms)}
            claimId={claimId}
            cpTerms={cpTerms}
            onCpTermsChange={onCpTermsChange}
            result={result}
            clauseFlags={clauseFlags}
            onRunClauseAnalysis={onRunClauseAnalysis}
            onExport={onExport}
            exporting={exporting}
            flagging={flagging}
          />
        )}
      </div>
    </div>
  );
}
