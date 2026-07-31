-- Which terminal, not just which port.
--
-- Crane rates vary more WITHIN a port than between ports: a modern grab-crane
-- berth and a barge-fed quay in the same harbour are different machines, and
-- benchmarking one against the other produces a shortfall that is a fact about
-- the berth rather than about the call. A port-level market median is therefore
-- the wrong comparator whenever the terminal is known.
--
-- NULLABLE and NOT backfilled. Every claim on file records only a port, and
-- inventing a terminal for them would key the benchmark on a fiction. The
-- market resolver instead CASCADES: it looks for a terminal-level bucket first,
-- falls back to the port when the terminal bucket is below the k-anonymity
-- floors or unknown, and states which scope it actually used — an operator
-- comparing against "Rotterdam" rather than "Rotterdam / ECT Delta" needs to
-- know that, because it changes what the number means.
--
-- Free text rather than a foreign key to a terminal registry: no such registry
-- exists here, and a half-populated lookup table would be worse than a string
-- an operator can type. Matching is on a normalised key, so casing and spacing
-- do not fragment a bucket.

ALTER TABLE public.claims
  ADD COLUMN IF NOT EXISTS terminal_name text;

-- Benchmarks read (port, terminal) together, so the index carries both. Partial
-- on the non-null case: rows without a terminal are served by the port-level
-- path and would only bloat this index.
CREATE INDEX IF NOT EXISTS idx_claims_port_terminal
  ON public.claims (lower(trim(port)), lower(trim(terminal_name)))
  WHERE terminal_name IS NOT NULL;

COMMENT ON COLUMN public.claims.terminal_name IS
  'Berth or terminal within the port, free text (e.g. "ECT Delta"). NULL = not recorded, which is NOT the same as "the whole port": the market benchmark cascades to port level and says so rather than silently comparing a specialised berth against a port-wide median.';
