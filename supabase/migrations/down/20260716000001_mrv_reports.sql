-- Down migration for 20260716000001_mrv_reports.sql — reverse order.
--
-- NB this destroys every sealed MRV report. The seals are the only evidence
-- of what the book looked like at each sealing instant and cannot be
-- regenerated for a past state; export the rows first if they matter.

DROP POLICY IF EXISTS "Users manage MRV reports of their company" ON public.mrv_reports;
DROP INDEX IF EXISTS public.idx_mrv_reports_company_period;
DROP TABLE IF EXISTS public.mrv_reports;
