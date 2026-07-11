import { CpTerms, LaytimeResult } from "@/lib/laytime/types";

export interface CompanyRow {
  id: string;
  name: string;
  created_at?: string;
}

export interface DocumentRow {
  id: string;
  claim_id: string;
  file_name: string;
  file_path: string;
  created_at: string;
}

export interface SofEventRow {
  id: string;
  claim_id: string;
  event_type: string;
  occurred_at: string;
  page: number;
  confidence: number;
  raw_text: string;
  source: string;
  status: string;
  ai_reasoning: string | null;
  created_at?: string;
}

export interface LaytimeCalculationRow {
  id: string;
  claim_id: string;
  computed_at: string;
  demurrage_amount: number;
  despatch_amount: number;
  currency: string;
  used_hours: number;
  allowed_hours: number;
  breakdown: LaytimeResult["breakdown"];
}

export interface ClauseFlagRow {
  id: string;
  event_id: string;
  clause_ref: string;
  severity: "info" | "warning" | "critical";
  note: string;
  created_at?: string;
}

export interface ClaimWithRelations {
  id: string;
  company_id: string;
  vessel: string;
  voyage_ref: string;
  port: string;
  cargo: string;
  cp_form: string;
  cp_terms: CpTerms;
  status: string;
  created_at: string;
  updated_at: string;
  companies?: CompanyRow;
  documents?: DocumentRow[];
  sof_events?: SofEventRow[];
  laytime_calculations?: LaytimeCalculationRow | LaytimeCalculationRow[];
}
