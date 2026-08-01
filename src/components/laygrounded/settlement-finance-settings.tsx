"use client";

// Settlement party details and escrow deployments.
//
// The validators here are IMPORTED FROM THE SERVER MODULE, not reimplemented.
// `counterparty-finance.ts` is pure — no I/O, no server-only imports — precisely
// so this can happen. A second client-side IBAN check would drift from the
// server's within a release or two, and the failure mode of that drift is a form
// that accepts an IBAN the API then rejects, or worse, one it accepts.
//
// Validation runs as you type but only BLOCKS on submit: an IBAN is invalid for
// most of the time you are typing it, and a field that turns red on the second
// character teaches people to ignore it.

import { useEffect, useMemo, useState } from "react";
import { Banknote, Check, Link2, Plus, Trash2, Wallet, AlertCircle } from "lucide-react";
import {
  isValidBic,
  isValidIban,
  isValidWalletAddress,
  normaliseIban,
  validateCounterpartyFinance,
  type CounterpartyFinanceRecord,
  type PartyKind,
} from "@/lib/settlement/counterparty-finance";
import styles from "./SettlementFinanceSettings.module.css";

interface ChainConfig {
  id: string;
  chainId: number;
  verifyingContract: string;
  tokenAddress: string | null;
  label: string | null;
}

const BLANK = {
  partyKind: "self" as PartyKind,
  counterpartyName: "",
  legalName: "",
  country: "",
  iban: "",
  bic: "",
  bankName: "",
  walletAddress: "",
  chainId: "",
};

type Draft = typeof BLANK;

/** Well-known EIP-155 ids, purely as labels for the picker. */
const KNOWN_CHAINS: Record<number, string> = {
  1: "Ethereum Mainnet",
  10: "OP Mainnet",
  56: "BNB Smart Chain",
  137: "Polygon",
  8453: "Base",
  42161: "Arbitrum One",
  11155111: "Sepolia (testnet)",
};

function chainLabel(id: number, label: string | null): string {
  return label?.trim() || KNOWN_CHAINS[id] || `Chain ${id}`;
}

export function SettlementFinanceSettings() {
  const [records, setRecords] = useState<CounterpartyFinanceRecord[]>([]);
  const [configs, setConfigs] = useState<ChainConfig[]>([]);
  const [platformFallback, setPlatformFallback] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const [draft, setDraft] = useState<Draft>(BLANK);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const [chainDraft, setChainDraft] = useState({ chainId: "", verifyingContract: "", tokenAddress: "", label: "" });
  const [savingChain, setSavingChain] = useState(false);

  async function load() {
    try {
      const [a, b] = await Promise.all([
        fetch("/api/settlement/counterparty-finance").then((r) => r.json()),
        fetch("/api/settlement/chain-configs").then((r) => r.json()),
      ]);
      setRecords(a.records ?? []);
      setConfigs(b.configs ?? []);
      setPlatformFallback(Boolean(b.platformFallbackConfigured));
      setError(null);
    } catch {
      setError("Could not load settlement details.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const hasSelf = records.some((r) => r.partyKind === "self");

  // The same validator the API runs, so the form can never disagree with it.
  const validation = useMemo(
    () =>
      validateCounterpartyFinance({
        partyKind: draft.partyKind,
        counterpartyName: draft.partyKind === "counterparty" ? draft.counterpartyName : null,
        legalName: draft.legalName,
        country: draft.country || null,
        iban: draft.iban || null,
        bic: draft.bic || null,
        bankName: draft.bankName || null,
        walletAddress: draft.walletAddress || null,
        chainId: draft.chainId ? Number(draft.chainId) : null,
      }),
    [draft]
  );

  // Per-field hints, shown once the field has content — a green tick on a
  // correct IBAN is worth more than an error on an incomplete one.
  const ibanState = draft.iban.trim() ? (isValidIban(draft.iban) ? "ok" : "bad") : null;
  const bicState = draft.bic.trim() ? (isValidBic(draft.bic) ? "ok" : "bad") : null;
  const walletState = draft.walletAddress.trim()
    ? isValidWalletAddress(draft.walletAddress)
      ? "ok"
      : "bad"
    : null;

  function edit(r: CounterpartyFinanceRecord) {
    setEditingId(r.id);
    setSubmitted(false);
    setDraft({
      partyKind: r.partyKind,
      // `partyKey` is the normalised match key; showing the legal name back is
      // closer to what the operator typed.
      counterpartyName: r.partyKey ?? "",
      legalName: r.legalName,
      country: r.country ?? "",
      iban: r.iban ?? "",
      bic: r.bic ?? "",
      bankName: r.bankName ?? "",
      walletAddress: r.walletAddress ?? "",
      chainId: r.chainId != null ? String(r.chainId) : "",
    });
  }

  function reset() {
    setDraft(BLANK);
    setEditingId(null);
    setSubmitted(false);
  }

  async function saveParty() {
    setSubmitted(true);
    if (!validation.ok) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settlement/counterparty-finance", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          partyKind: draft.partyKind,
          counterpartyName: draft.partyKind === "counterparty" ? draft.counterpartyName : null,
          legalName: draft.legalName,
          country: draft.country || null,
          iban: draft.iban || null,
          bic: draft.bic || null,
          bankName: draft.bankName || null,
          walletAddress: draft.walletAddress || null,
          chainId: draft.chainId ? Number(draft.chainId) : null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.reasons?.join(" · ") ?? json.error ?? "Save failed");
      setSaved("Party details saved.");
      setTimeout(() => setSaved(null), 2500);
      reset();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function removeParty(id: string, name: string) {
    if (!confirm(`Delete the settlement details for ${name}? Payments to this party will report missing bank details until they are re-entered.`)) return;
    try {
      const res = await fetch(`/api/settlement/counterparty-finance?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      if (editingId === id) reset();
      await load();
    } catch {
      setError("Could not delete that record.");
    }
  }

  async function saveChain() {
    setSavingChain(true);
    setError(null);
    try {
      const res = await fetch("/api/settlement/chain-configs", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chainId: Number(chainDraft.chainId),
          verifyingContract: chainDraft.verifyingContract,
          tokenAddress: chainDraft.tokenAddress || null,
          label: chainDraft.label || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.reasons?.join(" · ") ?? json.error ?? "Save failed");
      setChainDraft({ chainId: "", verifyingContract: "", tokenAddress: "", label: "" });
      setSaved("Escrow deployment saved.");
      setTimeout(() => setSaved(null), 2500);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSavingChain(false);
    }
  }

  async function removeChain(id: string, label: string) {
    if (!confirm(`Remove the escrow deployment for ${label}? Settlements on that chain will stop generating an EIP-712 leg.`)) return;
    try {
      await fetch(`/api/settlement/chain-configs?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      await load();
    } catch {
      setError("Could not delete that deployment.");
    }
  }

  const chainOk =
    Number(chainDraft.chainId) > 0 &&
    Number.isInteger(Number(chainDraft.chainId)) &&
    isValidWalletAddress(chainDraft.verifyingContract) &&
    (!chainDraft.tokenAddress.trim() || isValidWalletAddress(chainDraft.tokenAddress));

  if (loading) return <p className={styles.loading}>Loading settlement details…</p>;

  return (
    <div className={styles.wrap}>
      <p className={styles.intro}>
        Where settlement money actually goes. These details populate the ISO&nbsp;20022 payment
        instruction and the EIP-712 escrow payload generated when a claim is agreed. Anything left
        blank is reported as <em>missing</em> on the payload rather than guessed — a placeholder
        would look complete and either fail at the bank or pay the wrong account.
      </p>

      {error && (
        <p className={styles.error}>
          <AlertCircle size={14} /> {error}
        </p>
      )}
      {saved && (
        <p className={styles.saved}>
          <Check size={14} /> {saved}
        </p>
      )}

      {!hasSelf && (
        <p className={styles.warn}>
          <AlertCircle size={14} /> Your own company has no banking details yet. Without them every
          settlement payload will be missing its creditor account.
        </p>
      )}

      {/* ── Parties ─────────────────────────────────────────────────────── */}
      <h3 className={styles.sectionTitle}>
        <Banknote size={15} /> Settlement parties
      </h3>

      <ul className={styles.list}>
        {records.map((r) => (
          <li key={r.id} className={styles.row}>
            <div className={styles.main}>
              <div className={styles.head}>
                <strong>{r.legalName}</strong>
                <span className={r.partyKind === "self" ? styles.tagSelf : styles.tag}>
                  {r.partyKind === "self" ? "your company" : "counterparty"}
                </span>
                {r.country && <span className={styles.country}>{r.country}</span>}
              </div>
              <p className={styles.details}>
                {r.iban ? (
                  <>
                    <span className="tnum">{r.iban}</span>
                    {r.bic && <> · {r.bic}</>}
                    {r.bankName && <> · {r.bankName}</>}
                  </>
                ) : (
                  <span className={styles.muted}>no bank account</span>
                )}
              </p>
              <p className={styles.details}>
                {r.walletAddress ? (
                  <>
                    <Wallet size={11} /> <span className="tnum">{r.walletAddress}</span> ·{" "}
                    {chainLabel(r.chainId!, null)}
                  </>
                ) : (
                  <span className={styles.muted}>no wallet</span>
                )}
              </p>
              {r.partyKind === "counterparty" && (
                <p className={styles.matchNote}>
                  Matched to claims whose counterparty is “{r.partyKey}”.
                </p>
              )}
            </div>
            <div className={styles.actions}>
              <button type="button" className={styles.linkBtn} onClick={() => edit(r)}>
                Edit
              </button>
              <button
                type="button"
                className={styles.deleteBtn}
                onClick={() => void removeParty(r.id, r.legalName)}
                title="Delete"
              >
                <Trash2 size={15} />
              </button>
            </div>
          </li>
        ))}
        {records.length === 0 && (
          <li className={styles.empty}>No settlement parties configured yet.</li>
        )}
      </ul>

      <div className={styles.form}>
        <h4 className={styles.formTitle}>
          {editingId ? "Edit party" : <><Plus size={13} /> Add a party</>}
        </h4>

        <div className={styles.grid}>
          <label className={styles.field}>
            <span className={styles.label}>Party</span>
            <select
              className={styles.input}
              value={draft.partyKind}
              disabled={saving}
              onChange={(e) => setDraft({ ...draft, partyKind: e.target.value as PartyKind })}
            >
              <option value="self">Your company</option>
              <option value="counterparty">A counterparty</option>
            </select>
          </label>

          {draft.partyKind === "counterparty" && (
            <label className={styles.field}>
              <span className={styles.label}>
                Counterparty name <span className={styles.hint}>must match the claim</span>
              </span>
              <input
                className={styles.input}
                value={draft.counterpartyName}
                disabled={saving}
                placeholder="ACME Shipping Ltd"
                onChange={(e) => setDraft({ ...draft, counterpartyName: e.target.value })}
              />
            </label>
          )}

          <label className={styles.field}>
            <span className={styles.label}>
              Legal name <span className={styles.hint}>as the bank holds it</span>
            </span>
            <input
              className={styles.input}
              value={draft.legalName}
              disabled={saving}
              placeholder="ACME Shipping Limited"
              onChange={(e) => setDraft({ ...draft, legalName: e.target.value })}
            />
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Country</span>
            <input
              className={styles.input}
              value={draft.country}
              disabled={saving}
              maxLength={2}
              placeholder="GB"
              onChange={(e) => setDraft({ ...draft, country: e.target.value.toUpperCase() })}
            />
          </label>

          <label className={`${styles.field} ${styles.wide}`}>
            <span className={styles.label}>
              IBAN
              {ibanState === "ok" && (
                <span className={styles.ok}>
                  <Check size={11} /> checksum valid
                </span>
              )}
              {ibanState === "bad" && <span className={styles.bad}>fails the ISO 13616 checksum</span>}
            </span>
            <input
              className={`${styles.input} ${ibanState === "bad" ? styles.inputBad : ""}`}
              value={draft.iban}
              disabled={saving}
              placeholder="GB33 BUKB 2020 1555 5555 55"
              onChange={(e) => setDraft({ ...draft, iban: e.target.value })}
              onBlur={(e) =>
                e.target.value.trim() && setDraft({ ...draft, iban: normaliseIban(e.target.value) })
              }
            />
          </label>

          <label className={styles.field}>
            <span className={styles.label}>
              BIC
              {bicState === "bad" && <span className={styles.bad}>not a valid ISO 9362 code</span>}
            </span>
            <input
              className={`${styles.input} ${bicState === "bad" ? styles.inputBad : ""}`}
              value={draft.bic}
              disabled={saving}
              placeholder="BUKBGB22"
              onChange={(e) => setDraft({ ...draft, bic: e.target.value.toUpperCase() })}
            />
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Bank name</span>
            <input
              className={styles.input}
              value={draft.bankName}
              disabled={saving}
              placeholder="Barclays"
              onChange={(e) => setDraft({ ...draft, bankName: e.target.value })}
            />
          </label>

          <label className={`${styles.field} ${styles.wide}`}>
            <span className={styles.label}>
              Wallet address <span className={styles.hint}>optional</span>
              {walletState === "bad" && <span className={styles.bad}>must be 0x + 40 hex characters</span>}
            </span>
            <input
              className={`${styles.input} ${walletState === "bad" ? styles.inputBad : ""}`}
              value={draft.walletAddress}
              disabled={saving}
              placeholder="0x…"
              onChange={(e) => setDraft({ ...draft, walletAddress: e.target.value })}
            />
          </label>

          <label className={styles.field}>
            <span className={styles.label}>
              Chain <span className={styles.hint}>required with a wallet</span>
            </span>
            <select
              className={styles.input}
              value={draft.chainId}
              disabled={saving}
              onChange={(e) => setDraft({ ...draft, chainId: e.target.value })}
            >
              <option value="">—</option>
              {Object.entries(KNOWN_CHAINS).map(([id, name]) => (
                <option key={id} value={id}>
                  {name} ({id})
                </option>
              ))}
            </select>
          </label>
        </div>

        <p className={styles.checksumNote}>
          The IBAN is checked with the ISO 13616 MOD-97 checksum — the same arithmetic the receiving
          bank performs. A wallet address is checked for <em>shape only</em>: verifying its EIP-55
          checksum needs keccak-256, which this system deliberately does not implement, so a
          well-formed address is not proof the account exists.
        </p>

        {submitted && !validation.ok && (
          <ul className={styles.errors}>
            {validation.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}

        <div className={styles.formActions}>
          <button
            type="button"
            className={styles.primary}
            onClick={() => void saveParty()}
            disabled={saving}
          >
            {saving ? "Saving…" : editingId ? "Save changes" : "Add party"}
          </button>
          {editingId && (
            <button type="button" className={styles.linkBtn} onClick={reset} disabled={saving}>
              Cancel
            </button>
          )}
        </div>
      </div>

      {/* ── Escrow deployments ──────────────────────────────────────────── */}
      <h3 className={styles.sectionTitle}>
        <Link2 size={15} /> Escrow deployments
      </h3>
      <p className={styles.intro}>
        The contract that receives an on-chain settlement, per chain. An escrow contract is a
        deployment on <strong>one</strong> chain — the same address elsewhere is a different
        contract — so it is registered against the chain both parties settle on. Without a match, no
        EIP-712 leg is generated and the payload says so.
        {platformFallback && (
          <> A platform-wide default is configured and will be used for unlisted chains.</>
        )}
      </p>

      <ul className={styles.list}>
        {configs.map((c) => (
          <li key={c.id} className={styles.row}>
            <div className={styles.main}>
              <div className={styles.head}>
                <strong>{chainLabel(c.chainId, c.label)}</strong>
                <span className={styles.tag}>chain {c.chainId}</span>
              </div>
              <p className={styles.details}>
                <span className="tnum">{c.verifyingContract}</span>
              </p>
              <p className={styles.details}>
                {c.tokenAddress ? (
                  <>
                    token <span className="tnum">{c.tokenAddress}</span>
                  </>
                ) : (
                  <span className={styles.muted}>native asset</span>
                )}
              </p>
            </div>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.deleteBtn}
                onClick={() => void removeChain(c.id, chainLabel(c.chainId, c.label))}
                title="Remove"
              >
                <Trash2 size={15} />
              </button>
            </div>
          </li>
        ))}
        {configs.length === 0 && (
          <li className={styles.empty}>
            No escrow deployments registered — settlements will generate a bank instruction only.
          </li>
        )}
      </ul>

      <div className={styles.form}>
        <h4 className={styles.formTitle}>
          <Plus size={13} /> Register a deployment
        </h4>
        <div className={styles.grid}>
          <label className={styles.field}>
            <span className={styles.label}>Chain</span>
            <select
              className={styles.input}
              value={chainDraft.chainId}
              disabled={savingChain}
              onChange={(e) => setChainDraft({ ...chainDraft, chainId: e.target.value })}
            >
              <option value="">—</option>
              {Object.entries(KNOWN_CHAINS).map(([id, name]) => (
                <option key={id} value={id}>
                  {name} ({id})
                </option>
              ))}
            </select>
          </label>
          <label className={`${styles.field} ${styles.wide}`}>
            <span className={styles.label}>
              Escrow contract
              {chainDraft.verifyingContract.trim() && !isValidWalletAddress(chainDraft.verifyingContract) && (
                <span className={styles.bad}>must be 0x + 40 hex characters</span>
              )}
            </span>
            <input
              className={styles.input}
              value={chainDraft.verifyingContract}
              disabled={savingChain}
              placeholder="0x…"
              onChange={(e) => setChainDraft({ ...chainDraft, verifyingContract: e.target.value })}
            />
          </label>
          <label className={`${styles.field} ${styles.wide}`}>
            <span className={styles.label}>
              Settlement token <span className={styles.hint}>blank = native asset</span>
            </span>
            <input
              className={styles.input}
              value={chainDraft.tokenAddress}
              disabled={savingChain}
              placeholder="0x… (e.g. USDC)"
              onChange={(e) => setChainDraft({ ...chainDraft, tokenAddress: e.target.value })}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>
              Label <span className={styles.hint}>optional</span>
            </span>
            <input
              className={styles.input}
              value={chainDraft.label}
              disabled={savingChain}
              placeholder="Ethereum Mainnet"
              onChange={(e) => setChainDraft({ ...chainDraft, label: e.target.value })}
            />
          </label>
        </div>
        <div className={styles.formActions}>
          <button
            type="button"
            className={styles.primary}
            onClick={() => void saveChain()}
            disabled={savingChain || !chainOk}
          >
            {savingChain ? "Saving…" : "Register deployment"}
          </button>
        </div>
      </div>
    </div>
  );
}
