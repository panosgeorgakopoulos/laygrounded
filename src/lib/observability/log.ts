// Structured JSON logging for operational failure paths.
//
// One JSON object per line on stdout/stderr — greppable locally (dev.log)
// and machine-parseable by any log shipper. Every entry answers the two
// questions an on-call engineer actually has: does a human need to act
// (user_action_required), and what will the system do on its own
// (retry_strategy). trace_id stitches multi-step operations (a sync sweep,
// a webhook delivery) into one queryable thread.

import { randomUUID } from "crypto";

export type LogLevel = "info" | "warn" | "error";

export interface StructuredLogFields {
  trace_id: string;
  // Concrete instruction for a human, or null when the system self-heals.
  user_action_required?: string | null;
  // What the system does next on its own ("backoff retry at …", "none").
  retry_strategy?: string | null;
  [key: string]: unknown;
}

export function newTraceId(): string {
  return randomUUID();
}

export function logStructured(
  level: LogLevel,
  context: string,
  message: string,
  fields: StructuredLogFields
): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    context,
    message,
    user_action_required: null,
    retry_strategy: null,
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
