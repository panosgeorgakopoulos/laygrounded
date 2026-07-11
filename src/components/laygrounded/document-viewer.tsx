"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./DocumentViewer.module.css";

interface Bbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DocumentViewerProps {
  documentUrl: string | null;
  // Whether a document row exists at all, independent of documentUrl. A
  // document can exist with no usable URL (signing failed, object deleted) —
  // that must read as an error, not as "nothing uploaded yet".
  hasDocument: boolean;
  mime: string | null;
  extractionStatus: string;
  highlightedBbox: Bbox | null;
  highlightedPage: number | null;
  onUpload: (file: File) => void;
  onReplace: () => void;
}

export function DocumentViewer({
  documentUrl,
  hasDocument,
  mime,
  extractionStatus,
  highlightedBbox,
  highlightedPage,
  onUpload,
  onReplace,
}: DocumentViewerProps) {
  const [dragover, setDragover] = useState(false);
  const [pageImages, setPageImages] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);

  // For PDFs, render pages via pdfjs-dist (client-side).
  useEffect(() => {
    setLoadError(null);
    setPageImages([]);
    if (!documentUrl) {
      if (hasDocument) {
        setLoadError("This document has no accessible file.");
      }
      return;
    }
    if (mime === "application/pdf") {
      setLoading(true);
      (async () => {
        try {
          // Fetch the PDF as bytes first — a signed URL can be null, expired,
          // or point at a deleted object, and the server can answer with an
          // HTML error page instead of a PDF. Validate before handing
          // anything to pdf.js, which otherwise throws an opaque
          // InvalidPDFException for all of these cases alike.
          const res = await fetch(documentUrl);
          if (!res.ok) {
            throw new Error(`Document fetch failed (HTTP ${res.status})`);
          }
          const data = new Uint8Array(await res.arrayBuffer());
          const header = String.fromCharCode(...data.slice(0, 5));
          if (header !== "%PDF-") {
            throw new Error("Response is not a valid PDF file");
          }

          const pdfjs = await import("pdfjs-dist");
          // Use locally bundled worker (no CDN dependency).
          pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
          const loadingTask = pdfjs.getDocument({ data });
          const pdf = await loadingTask.promise;
          const pages: string[] = [];
          for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const viewport = page.getViewport({ scale: 1.2 });
            const canvas = document.createElement("canvas");
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            const ctx = canvas.getContext("2d")!;
            await page.render({ canvasContext: ctx, viewport } as any).promise;
            pages.push(canvas.toDataURL("image/png"));
          }
          setPageImages(pages);
        } catch (e) {
          console.error("PDF render error:", e);
          setLoadError(
            e instanceof Error ? e.message : "Unable to load this document"
          );
        } finally {
          setLoading(false);
        }
      })();
    } else {
      setPageImages([documentUrl]);
    }
  }, [documentUrl, mime, hasDocument]);

  // Scroll to highlighted page.
  useEffect(() => {
    if (highlightedPage && pageRefs.current[highlightedPage - 1]) {
      pageRefs.current[highlightedPage - 1]?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }
  }, [highlightedPage, highlightedBbox]);

  if (!hasDocument) {
    return (
      <div className={styles.emptyState}>
        <div
          className={`${styles.dropzone} ${dragover ? styles.dragover : ""}`}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragover(true);
          }}
          onDragLeave={() => setDragover(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragover(false);
            const f = e.dataTransfer.files?.[0];
            if (f) onUpload(f);
          }}
        >
          <div className={`${styles.uploadLabel} tnum`}>
            UPLOAD
          </div>
          <div className={styles.uploadTitle}>Upload Statement of Facts</div>
          <div className={styles.uploadSubtitle}>
            PDF or image, max 20 MB
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onUpload(f);
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={`${styles.statusText} tnum`}>
          {extractionStatus === "extracting" && "EXTRACTING…"}
          {extractionStatus === "extracted" && "DOCUMENT"}
          {extractionStatus === "pending" && "PENDING"}
          {extractionStatus === "failed" && "EXTRACTION FAILED"}
        </div>
        <button
          onClick={onReplace}
          className={`${styles.replaceBtn} tnum`}
        >
          REPLACE DOCUMENT
        </button>
      </div>
      <div className={styles.viewerArea}>
        {loading ? (
          <div className={`${styles.loadingText} tnum`}>
            RENDERING PAGES…
          </div>
        ) : loadError ? (
          <div className={`${styles.loadingText} tnum`}>
            UNABLE TO LOAD DOCUMENT — {loadError}
          </div>
        ) : (
          pageImages.map((src, idx) => {
            const page = idx + 1;
            const isHighlighted = highlightedPage === page && highlightedBbox;
            return (
              <div
                key={page}
                ref={(el) => {
                  pageRefs.current[idx] = el;
                }}
                className={styles.pageWrapper}
              >
                <img
                  src={src}
                  alt={`Page ${page}`}
                  className={styles.pageImage}
                />
                {isHighlighted && highlightedBbox && (
                  <div
                    className={styles.bboxHighlight}
                    style={{
                      left: `${highlightedBbox.x * 100}%`,
                      top: `${highlightedBbox.y * 100}%`,
                      width: `${highlightedBbox.width * 100}%`,
                      height: `${highlightedBbox.height * 100}%`,
                    }}
                  />
                )}
                <div className={`${styles.pageLabel} tnum`}>
                  p.{page}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
