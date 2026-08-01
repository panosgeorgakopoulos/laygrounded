"use client";

// Zero-data-entry SoF ingestion from TEXT.
//
// Complements the document dropzone rather than replacing it. That path sends
// page images to a vision model and is the right tool for a scanned SoF. This
// one runs a deterministic line-based extractor: instant, free, and the same
// text always yields the same events — which is what you want for a forwarded
// email body or a PDF's text layer, and what makes the result reproducible if
// somebody later disputes a figure derived from it.
//
// PREVIEW BEFORE COMMIT. Unstructured text can yield nonsense, and writing
// thirty junk events into a claim so the user can reject them one at a time is
// worse than showing them first. Nothing is written until "Add to timeline",
// and what is written lands as `suggested` — still facing the review queue,
// still invisible to the engine until confirmed.

import { useRef, useState } from "react";
import { AlertCircle, Check, FileText, Loader2, Sparkles, Upload, X } from "lucide-react";
import styles from "./SofTextIngest.module.css";

interface Candidate {
  event_type: string;
  occurred_at: string;
  raw_text: string;
  line: number;
}

interface PreviewState {
  events: Candidate[];
  warnings: string[];
  matchedLines: number;
  totalLines: number;
}

/** Text-ish files worth reading in the browser. A PDF belongs in the dropzone. */
const TEXT_EXTENSIONS = /\.(txt|eml|md|csv|log|text)$/i;
const MAX_CHARS = 50_000;

export function SofTextIngest({
  claimId,
  onIngested,
}: {
  claimId: string;
  onIngested: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [offset, setOffset] = useState("");
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [busy, setBusy] = useState(false);
  const [committed, setCommitted] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragover, setDragover] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function readFile(file: File) {
    if (!TEXT_EXTENSIONS.test(file.name)) {
      setError(
        `${file.name} is not a text file. PDFs and images go in the document uploader above, which reads them with the vision pipeline.`
      );
      return;
    }
    const content = await file.text();
    setText(content.slice(0, MAX_CHARS));
    setPreview(null);
    setError(content.length > MAX_CHARS ? `Only the first ${MAX_CHARS.toLocaleString()} characters were read.` : null);
  }

  async function call(commit: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/claims/${claimId}/ingest-sof-text`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text,
          ...(offset.trim() ? { defaultUtcOffset: offset.trim() } : {}),
          commit,
        }),
      });
      const body = await res.json();

      if (!res.ok) {
        if (body.error === "SOF_UNPARSEABLE") {
          setPreview(null);
          setError(
            `No datable events were found in ${body.totalLines ?? "the"} lines.` +
              (body.warnings?.length ? ` ${body.warnings.join(" ")}` : "")
          );
          return;
        }
        throw new Error(body.error ?? "Ingestion failed");
      }

      if (commit) {
        setCommitted(body.inserted);
        setPreview(null);
        setText("");
        onIngested();
      } else {
        setPreview(body as PreviewState);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ingestion failed");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className={styles.opener} onClick={() => setOpen(true)}>
        <Sparkles size={14} /> Paste SoF text instead
      </button>
    );
  }

  return (
    <section className={styles.panel} aria-label="Ingest Statement of Facts text">
      <header className={styles.head}>
        <h3 className={styles.title}>
          <FileText size={15} /> Ingest SoF text
        </h3>
        <button type="button" className={styles.close} onClick={() => setOpen(false)} aria-label="Close">
          <X size={15} />
        </button>
      </header>

      <p className={styles.intro}>
        Paste a Statement of Facts, or drop a <code>.txt</code> / <code>.eml</code> file. Events are
        extracted by a <strong>deterministic</strong> line matcher — no model call, instant, and the
        same text always produces the same events. For a scanned or photographed SoF, use the
        document uploader instead: that path reads page images.
      </p>

      <div
        className={`${styles.drop} ${dragover ? styles.dropActive : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragover(true);
        }}
        onDragLeave={() => setDragover(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragover(false);
          const f = e.dataTransfer.files?.[0];
          if (f) void readFile(f);
        }}
      >
        <textarea
          className={styles.textarea}
          value={text}
          maxLength={MAX_CHARS}
          placeholder={
            "Drop a .txt or .eml file here, or paste the SoF:\n\n" +
            "04/03/2024 08:00 +08:00  Notice of Readiness tendered\n" +
            "04/03/2024 14:00 +08:00  Vessel all fast alongside\n" +
            "04/03/2024 16:00 +08:00  Commenced loading"
          }
          onChange={(e) => {
            setText(e.target.value);
            setPreview(null);
            setCommitted(null);
          }}
          rows={8}
        />
        <div className={styles.dropFoot}>
          <button type="button" className={styles.fileBtn} onClick={() => fileRef.current?.click()}>
            <Upload size={12} /> Choose a text file
          </button>
          <span className={styles.count}>
            {text.length.toLocaleString()} / {MAX_CHARS.toLocaleString()}
          </span>
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.eml,.md,.csv,.log,text/plain,message/rfc822"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void readFile(f);
            }}
          />
        </div>
      </div>

      <div className={styles.offsetRow}>
        <label className={styles.offsetLabel} htmlFor="sof-offset">
          Port UTC offset <span className={styles.hint}>for lines with no timezone</span>
        </label>
        <input
          id="sof-offset"
          className={styles.offsetInput}
          value={offset}
          placeholder="+08:00"
          onChange={(e) => setOffset(e.target.value)}
        />
      </div>
      <p className={styles.offsetNote}>
        A timestamp with no zone is <strong>never guessed</strong>. Without an offset those lines are
        reported and skipped — a laytime figure computed from an assumed timezone is a wrong figure
        that looks right.
      </p>

      {error && (
        <p className={styles.error}>
          <AlertCircle size={14} /> {error}
        </p>
      )}

      {committed !== null && (
        <p className={styles.ok}>
          <Check size={14} /> Added {committed} event{committed === 1 ? "" : "s"} as suggestions.
          Confirm them in the timeline — they do not affect any figure until you do.
        </p>
      )}

      {preview && (
        <div className={styles.preview}>
          <div className={styles.previewHead}>
            <strong>{preview.events.length}</strong> event
            {preview.events.length === 1 ? "" : "s"} found in {preview.matchedLines} of{" "}
            {preview.totalLines} lines
          </div>

          {preview.warnings.length > 0 && (
            <ul className={styles.warnings}>
              {preview.warnings.map((w, i) => (
                <li key={i}>
                  <AlertCircle size={11} /> {w}
                </li>
              ))}
            </ul>
          )}

          <ul className={styles.candidates}>
            {preview.events.map((e, i) => (
              <li key={i} className={styles.candidate}>
                <span className={styles.candType}>{e.event_type.replace(/_/g, " ")}</span>
                <span className={`${styles.candTime} tnum`}>
                  {new Date(e.occurred_at).toISOString().replace("T", " ").slice(0, 16)}Z
                </span>
                <span className={styles.candRaw} title={e.raw_text}>
                  L{e.line}: {e.raw_text}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.secondary}
          disabled={busy || text.trim().length < 20}
          onClick={() => void call(false)}
        >
          {busy && !preview ? <Loader2 size={13} className={styles.spin} /> : null} Preview events
        </button>
        {preview && preview.events.length > 0 && (
          <button
            type="button"
            className={styles.primary}
            disabled={busy}
            onClick={() => void call(true)}
          >
            {busy ? <Loader2 size={13} className={styles.spin} /> : null} Add {preview.events.length} to
            timeline
          </button>
        )}
      </div>
    </section>
  );
}
