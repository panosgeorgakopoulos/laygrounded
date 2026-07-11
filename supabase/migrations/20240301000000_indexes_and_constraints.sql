-- DB-1: Unique constraint on laytime_calculations
ALTER TABLE public.laytime_calculations ADD CONSTRAINT laytime_calculations_claim_id_key UNIQUE (claim_id);

-- DB-3, DB-4, DB-5, DB-6: Foreign key indexes
CREATE INDEX idx_company_members_company_id ON public.company_members(company_id);
CREATE INDEX idx_claims_company_id ON public.claims(company_id);
CREATE INDEX idx_claims_created_by ON public.claims(created_by);
CREATE INDEX idx_documents_claim_id ON public.documents(claim_id);
CREATE INDEX idx_sof_events_claim_id ON public.sof_events(claim_id);
CREATE INDEX idx_sof_events_document_id ON public.sof_events(document_id);
CREATE INDEX idx_laytime_calculations_claim_id ON public.laytime_calculations(claim_id);

-- DB-7: Check constraints for status and event_type
ALTER TABLE public.claims 
ADD CONSTRAINT check_claims_status 
CHECK (status IN ('draft', 'processing', 'completed', 'failed', 'demurrage', 'despatch', 'in_progress'));

ALTER TABLE public.sof_events 
ADD CONSTRAINT check_sof_events_event_type 
CHECK (event_type IN (
  'NOR_TENDERED', 'ALL_FAST', 'HATCH_OPEN', 'HATCH_CLOSE', 
  'COMMENCED_LOADING', 'COMPLETED_LOADING', 'COMMENCED_DISCHARGE', 'COMPLETED_DISCHARGE', 
  'WEATHER_DELAY', 'SHIFTING', 'BERTHED', 'EXCEPTED_PERIOD_START', 'EXCEPTED_PERIOD_END'
));

ALTER TABLE public.sof_events 
ADD CONSTRAINT check_sof_events_status 
CHECK (status IN ('suggested', 'pending', 'accepted', 'rejected', 'edited'));
