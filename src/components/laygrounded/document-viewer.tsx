"use client";

import { useEffect, useRef, useState } from "react";

interface Bbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DocumentViewerProps {
  documentUrl: string | null;
  mime: string | null;
  extractionStatus: string;
  highlightedBbox: Bbox | null;
  highlightedPage: number | null;
  onUpload: (file: File) => void;
  onReplace: () => void;
}

export function DocumentViewer({
  documentUrl,
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);

  // For PDFs, render pages via pdfjs-dist (client-side).
  useEffect(() => {
    if (!documentUrl) return;
    if (mime === "application/pdf") {
      setLoading(true);
      (async () => {
        try {
          const pdfjs = await import("pdfjs-dist");
          // Use locally bundled worker (no CDN dependency).
          pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
          // Fetch the PDF as ArrayBuffer first to avoid worker transport issues.
          const res = await fetch(documentUrl);
          const data = new Uint8Array(await res.arrayBuffer());
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
        } finally {
          setLoading(false);
        }
      })();
    } else {
      setPageImages([documentUrl]);
    }
  }, [documentUrl, mime]);

  // Scroll to highlighted page.
  useEffect(() => {
    if (highlightedPage && pageRefs.current[highlightedPage - 1]) {
      pageRefs.current[highlightedPage - 1]?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }
  }, [highlightedPage, highlightedBbox]);

  if (!documentUrl) {
    return (
      <div className="h-full flex items-center justify-center p-6">
        <div
          className={`dropzone w-full max-w-sm p-12 text-center cursor-pointer ${dragover ? "dragover" : ""}`}
          style={{ borderRadius: 2 }}
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
          <div
            className="text-xs uppercase tracking-wider text-[#9ca3af] mb-3"
            style={{ fontFamily: "var(--font-jetbrains-mono)" }}
          >
            UPLOAD
          </div>
          <div className="text-[#f9fafb] mb-2">Upload Statement of Facts</div>
          <div className="text-xs text-[#6b7280]">
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
    <div className="h-full flex flex-col">
      <div className="border-b border-[#1f2937] px-4 py-2 flex items-center justify-between">
        <div
          className="text-xs uppercase tracking-wider text-[#9ca3af]"
          style={{ fontFamily: "var(--font-jetbrains-mono)" }}
        >
          {extractionStatus === "extracting" && "EXTRACTING…"}
          {extractionStatus === "extracted" && "DOCUMENT"}
          {extractionStatus === "pending" && "PENDING"}
          {extractionStatus === "failed" && "EXTRACTION FAILED"}
        </div>
        <button
          onClick={onReplace}
          className="text-xs text-[#9ca3af] hover:text-[#f59e0b]"
          style={{ fontFamily: "var(--font-jetbrains-mono)" }}
        >
          REPLACE DOCUMENT
        </button>
      </div>
      <div className="flex-1 overflow-y-auto bg-[#0a0f1e] p-4">
        {loading ? (
          <div
            className="text-xs text-[#9ca3af] text-center py-12"
            style={{ fontFamily: "var(--font-jetbrains-mono)" }}
          >
            RENDERING PAGES…
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
                className="relative mb-4 mx-auto"
                style={{ maxWidth: "100%" }}
              >
                <img
                  src={src}
                  alt={`Page ${page}`}
                  className="block w-full h-auto"
                  style={{ border: "1px solid #1f2937" }}
                />
                {isHighlighted && highlightedBbox && (
                  <div
                    className="bbox-highlight"
                    style={{
                      left: `${highlightedBbox.x * 100}%`,
                      top: `${highlightedBbox.y * 100}%`,
                      width: `${highlightedBbox.width * 100}%`,
                      height: `${highlightedBbox.height * 100}%`,
                    }}
                  />
                )}
                <div
                  className="absolute top-1 right-1 text-xs text-[#6b7280] px-1.5 py-0.5"
                  style={{
                    fontFamily: "var(--font-jetbrains-mono)",
                    background: "rgba(10,15,30,0.7)",
                  }}
                >
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
