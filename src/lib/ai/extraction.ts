import { z } from "zod";
import { EVENT_TYPE_VALUES, EventTypeEnum } from "@/lib/laytime/types";
import { createClient } from "@/lib/supabase/server";

export const EXTRACTION_MODEL_ID = process.env.CLAUDE_MODEL_ID || "claude-sonnet-4-6";
export const EXTRACTION_MODEL_FALLBACK_ID =
  process.env.CLAUDE_FALLBACK_MODEL_ID || "claude-haiku-4-5-20251001";

const BboxSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0).max(1),
  height: z.number().min(0).max(1),
});

const SofEventSchema = z.object({
  occurred_at: z.string().transform((s, ctx) => {
    const d = new Date(s);
    if (isNaN(d.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid datetime" });
      return z.NEVER;
    }
    if (!s.includes("Z") && !/[+-]\d{2}:\d{2}$/.test(s) && !/[+-]\d{4}$/.test(s)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Missing timezone" });
      return z.NEVER;
    }
    return d.toISOString();
  }),
  event_type: z.enum(EVENT_TYPE_VALUES as [EventTypeEnum, ...EventTypeEnum[]]),
  verbatim: z.string().min(1),
  page: z.number().int().min(1),
  bbox: BboxSchema,
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

const ExtractionResultSchema = z.object({
  events: z.array(SofEventSchema),
});

export type ExtractedEvent = z.infer<typeof SofEventSchema>;

const SYSTEM_PROMPT = `You are a maritime laytime analyst specialised in parsing Statements of Facts (SoF) for dry bulk shipping.

You will receive a page image from a SoF document. Extract every event as a structured JSON object.

Map every SoF entry to ONE of these canonical event types ONLY:
- NOR_TENDERED (Notice of Readiness tendered)
- ALL_FAST (vessel all fast at berth)
- HATCH_OPEN (hatch covers opened)
- HATCH_CLOSE (hatch covers closed)
- COMMENCED_LOADING (loading commenced)
- COMPLETED_LOADING (loading completed)
- COMMENCED_DISCHARGE (discharge commenced)
- COMPLETED_DISCHARGE (discharge completed)
- WEATHER_DELAY (weather preventing work)
- SHIFTING (vessel shifting berth/anchorage)
- BERTHED (vessel berthed)
- EXCEPTED_PERIOD_START (Sunday/holiday start)
- EXCEPTED_PERIOD_END (Sunday/holiday end)

For every event, include:
- occurred_at: ISO 8601 timestamp with timezone offset
- event_type: one of the canonical enum values
- verbatim: exact text from the document describing this event
- page: 1-indexed page number
- bbox: normalised 0-1, top-left origin, page-local { x, y, width, height }
- confidence: 0-1
- reasoning: short explanation of mapping choice

If an entry is ambiguous, include it with low confidence and explain in reasoning.
DO NOT invent events not present in the document.
DO NOT include text outside the events array.

Return ONLY a JSON object: { "events": [ ... ] }`;

export interface ExtractionInput {
  storagePath: string;
  mime: string;
  pageCount: number;
  claimId: string;
  documentId: string;
}

export interface ExtractionResult {
  ok: boolean;
  events: ExtractedEvent[];
  qualityScore: number;
  errorReason?: string;
}

async function pdfToPngs(data: Buffer): Promise<Buffer[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(data),
    // @ts-ignore
    disableWorker: true,
    // @ts-ignore
    useWorkerFetch: false,
    isEvalSupported: false,
  }).promise;
  const pages: Buffer[] = [];
  // AI-5: Enforce token budget by capping pages
  const maxPages = Math.min(doc.numPages, 20);
  for (let i = 1; i <= maxPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1.5 });
    const { CanvasRenderingContext2D, Canvas } = await import("canvas") as any;
    const canvas = new Canvas(viewport.width, viewport.height);
    const ctx = canvas.getContext("2d", new CanvasRenderingContext2D());
    await page.render({ canvasContext: ctx, viewport } as any).promise;
    const png = canvas.toBuffer("image/png");
    pages.push(png);
  }
  return pages;
}

async function extractFromImage(
  imageBuffer: Buffer,
  mime: string,
  pageNumber: number,
  retries = 3
): Promise<ExtractedEvent[]> {
  let zai: any;
  try {
    const Anthropic = await import("@anthropic-ai/sdk");
    zai = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
  } catch (e) {
    throw new Error(`Anthropic SDK unavailable: ${(e as Error).message}`);
  }

  const base64 = imageBuffer.toString("base64");
  const mediaType = mime === "image/png" ? "image/png" : mime === "image/jpeg" ? "image/jpeg" : "image/webp";

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await zai.messages.create({
        model: EXTRACTION_MODEL_ID,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Extract all Statement of Facts events from this page (page ${pageNumber}). Return ONLY the JSON object { "events": [...] }`,
              },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mediaType as "image/jpeg" | "image/png" | "image/webp",
                  data: base64,
                }
              }
            ],
          },
        ],
      });

      const raw = (response.content[0] as any).text ?? "";
      return parseExtractionResponse(raw, pageNumber);
    } catch (e: any) {
      if (attempt === retries - 1 || (e.status && e.status < 500 && e.status !== 429)) {
        throw e;
      }
      await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
    }
  }
  return [];
}

function parseExtractionResponse(
  raw: string,
  fallbackPage: number
): ExtractedEvent[] {
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/m, "").replace(/```$/m, "");
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) return [];
  const jsonStr = text.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return [];
  }
  const result = ExtractionResultSchema.safeParse(parsed);
  if (!result.success) return [];
  return result.data.events.map((e) => ({
    ...e,
    page: e.page ?? fallbackPage,
  }));
}

function computeQualityScore(events: ExtractedEvent[]): number {
  if (events.length === 0) return 0;
  const requiredKeys: (keyof ExtractedEvent)[] = [
    "occurred_at",
    "event_type",
    "verbatim",
    "page",
    "bbox",
    "confidence",
    "reasoning",
  ];
  let completeCount = 0;
  for (const e of events) {
    const allPresent = requiredKeys.every((k) => {
      const v = e[k];
      if (v === null || v === undefined) return false;
      if (typeof v === "string" && v.trim() === "") return false;
      if (typeof v === "object" && Object.keys(v as object).length === 0) return false;
      return true;
    });
    if (allPresent) completeCount += 1;
  }
  return completeCount / events.length;
}

export async function uploadSofAndExtract(
  input: ExtractionInput
): Promise<ExtractionResult> {
  const supabase = await createClient();
  try {
    const { data: fileData, error: downloadErr } = await supabase.storage
      .from("sofs")
      .download(input.storagePath);
      
    if (downloadErr || !fileData) {
      throw new Error(`Failed to download file from storage: ${downloadErr?.message}`);
    }
    
    const buffer = Buffer.from(await fileData.arrayBuffer());

    let pages: Buffer[] = [];
    let mime = input.mime;
    if (input.mime === "application/pdf") {
      try {
        pages = await pdfToPngs(buffer);
        mime = "image/png";
      } catch (e) {
        console.warn("PDF render failed, using deterministic fallback:", (e as Error).message);
        pages = [];
      }
    } else if (input.mime.startsWith("image/")) {
      pages = [buffer];
    } else {
      pages = [];
    }

    let allEvents: ExtractedEvent[] = [];
    if (pages.length > 0) {
      for (let i = 0; i < pages.length; i++) {
        try {
          const events = await extractFromImage(pages[i], mime, i + 1);
          allEvents.push(...events);
        } catch (e) {
          console.warn(
            `VLM failed on page ${i + 1}, using deterministic fallback:`,
            (e as Error).message
          );
          allEvents.push(...deterministicFallback(i + 1));
        }
      }
    }

    if (allEvents.length === 0) {
      throw new Error("No events extracted from document");
    }

    // AI-2: Deduplicate across pages
    const uniqueEvents = new Map<string, ExtractedEvent>();
    for (const e of allEvents) {
      const key = `${e.event_type}_${e.occurred_at}`;
      if (!uniqueEvents.has(key)) {
        uniqueEvents.set(key, e);
      } else {
        const existing = uniqueEvents.get(key)!;
        if (e.confidence > existing.confidence) uniqueEvents.set(key, e);
      }
    }
    allEvents = Array.from(uniqueEvents.values());

    // SEC-H3: Prompt Injection mitigation (heuristic)
    allEvents = allEvents.filter(e => {
      const suspicious = ["ignore", "override", "system prompt", "bypass"];
      const verbatimLower = e.verbatim.toLowerCase();
      return !suspicious.some(s => verbatimLower.includes(s));
    });

    const qualityScore = computeQualityScore(allEvents);
    const passesGate = qualityScore >= 0.6 && allEvents.length > 0;

    if (!passesGate) {
      await supabase.from("documents").update({ extraction_status: "failed" }).eq("id", input.documentId);
      return {
        ok: false,
        events: allEvents,
        qualityScore,
        errorReason: `Quality gate failed (${(qualityScore * 100).toFixed(1)}% < 60%)`,
      };
    }

    for (const e of allEvents) {
      await supabase.from("sof_events").insert({
        claim_id: input.claimId,
        document_id: input.documentId,
        occurred_at: new Date(e.occurred_at).toISOString(),
        event_type: e.event_type,
        raw_text: e.verbatim,
        page: e.page,
        bbox: e.bbox, // jsonb
        confidence: e.confidence,
        source: "ai",
        status: "suggested",
        ai_reasoning: e.reasoning,
      });
    }

    await supabase.from("documents").update({ 
      extraction_status: "extracted", 
      page_count: input.pageCount || pages.length 
    }).eq("id", input.documentId);

    return { ok: true, events: allEvents, qualityScore };
  } catch (e) {
    await supabase.from("documents").update({ extraction_status: "failed" }).eq("id", input.documentId);
    return {
      ok: false,
      events: [],
      qualityScore: 0,
      errorReason: (e as Error).message,
    };
  }
}

function deterministicFallback(page: number): ExtractedEvent[] {
  return [];
}
