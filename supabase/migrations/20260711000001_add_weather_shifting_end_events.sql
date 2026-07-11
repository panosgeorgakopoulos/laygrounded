-- Adds explicit end-marker event types for weather delay and shifting.
--
-- Previously WEATHER_DELAY and SHIFTING had no paired "end" type (unlike
-- HATCH_OPEN/HATCH_CLOSE or EXCEPTED_PERIOD_START/END), so the laytime engine
-- treated "whatever event happens to be logged next" as the end of the delay
-- — silently misclassifying hours, sometimes by days, whenever the next
-- logged event wasn't actually the resolution of the delay. See
-- src/lib/laytime/gencon94.ts (getPairedIntervals) for the corrected logic.

ALTER TABLE public.sof_events DROP CONSTRAINT IF EXISTS check_sof_events_event_type;
ALTER TABLE public.sof_events
ADD CONSTRAINT check_sof_events_event_type
CHECK (event_type IN (
  'NOR_TENDERED', 'ALL_FAST', 'HATCH_OPEN', 'HATCH_CLOSE',
  'COMMENCED_LOADING', 'COMPLETED_LOADING', 'COMMENCED_DISCHARGE', 'COMPLETED_DISCHARGE',
  'WEATHER_DELAY', 'WEATHER_DELAY_END', 'SHIFTING', 'SHIFTING_END',
  'BERTHED', 'EXCEPTED_PERIOD_START', 'EXCEPTED_PERIOD_END'
));
