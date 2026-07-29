# Risk & compliance

`sanctions.ts` screens vessels (name + IMO) and counterparties against an OpenSanctions-compatible matching API (`SANCTIONS_API_KEY`; unset → honest "unavailable", never a silent pass; verdict bands with a deliberate human-review middle band). `ets.ts` is a pure EU ETS estimator (delay hours → at-berth fuel burn → tCO₂ → EUA cost; every default documented and overridable, `ETS_EUA_PRICE_EUR`). `service.ts` runs the scan (replace-on-rerun snapshot into `compliance_checks` + `ets_estimates`) and is fired automatically on claim creation (fire-and-forget in the claims POST route) plus on demand via `/api/claims/[claimId]/compliance`.

This directory also holds `emissions.ts` (MARPOL Annex VI), `fueleu.ts` (Reg (EU) 2023/1805), `mrv.ts` (Merkle-sealed annual report — do not graft new fields onto it), and ETS scope/phase-in (`etsChargeableShare`).
