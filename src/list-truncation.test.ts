import { describe, it, expect } from "vitest";
import { fitListPage, TRUNCATE_BUDGET } from "./api.js";

// SS06283: list_entries on 154 AutoCount stock rows came back with 4 rows, hasMore false and a
// message to "paginate with currentPage/pageSize". A client that trusts hasMore, or the length of
// the list, took the 4 rows for everything; one that paged on with the same pageSize skipped the
// other 150. Two causes: the budget was charged for the indentation of the platform's own body
// (every row's, the dropped ones' too), and a cut page kept the platform's hasMore.

type Row = { entryId: string; documentId: string; data: Record<string, unknown>; state: string };

const row = (i: number, fields: number, pad = 40): Row => ({
  entryId: `${1000 + i}|`,
  documentId: `ITEM-${String(i).padStart(4, "0")}`,
  data: Object.fromEntries(
    Array.from({ length: fields }, (_, f) => [`Field ${f + 1}`, `${"x".repeat(pad)}-${i}-${f}`]),
  ),
  state: "Active",
});

/** The platform's answer for one page: page arithmetic only, as MCPController works hasMore out. */
const platform = (rows: Row[], pageSize: number, currentPage: number) => {
  const list = rows.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  return {
    module: "Stock Levels",
    listing: "All Stock Levels",
    page: currentPage,
    pageSize,
    totalItems: rows.length,
    hasMore: (currentPage + 1) * pageSize < rows.length,
    list,
  };
};

const sent = (data: unknown) => JSON.stringify(data).length;

describe("fitListPage", () => {
  const wide = Array.from({ length: 154 }, (_, i) => row(i, 12));
  const narrow = Array.from({ length: 154 }, (_, i) => row(i, 3, 12));

  it("returns a page whole when what is sent fits, whatever the platform's indentation weighs", () => {
    const page = platform(narrow, 500, 0);
    // The platform's body is indented JSON: this page is over the cap as the platform sent it,
    // and under it as the tool sends it.
    expect(JSON.stringify(page, null, 2).length).toBeGreaterThan(TRUNCATE_BUDGET);
    expect(sent(page)).toBeLessThan(TRUNCATE_BUDGET);

    const out = fitListPage(page) as any;

    expect(out.list).toHaveLength(154);
    expect(out.hasMore).toBe(false);
    expect(out._truncated).toBeUndefined();
  });

  it("keeps as many wide rows as the budget holds, not a handful", () => {
    const page = platform(wide, 500, 0);
    const perRow = sent(page.list[0]) + 1;
    const fits = Math.floor((TRUNCATE_BUDGET - sent({ ...page, list: [] })) / perRow);

    const out = fitListPage(page) as any;

    expect(out.list.length).toBeGreaterThanOrEqual(fits - 1);
    expect(out.list.length).toBeLessThanOrEqual(fits);
    expect(out.list.length).toBeGreaterThan(20);
    expect(sent({ ...out, _truncated_message: "" })).toBeLessThanOrEqual(TRUNCATE_BUDGET + 200);
  });

  it("a cut page says so: hasMore, how many rows are here, and the call that reads on", () => {
    const out = fitListPage(platform(wide, 500, 0)) as any;
    const kept = out.list.length;

    expect(out._truncated).toBe(true);
    expect(out._returned).toBe(kept);
    // The platform said false: the page held every row of the listing.
    expect(out.hasMore).toBe(true);
    expect(out._next).toEqual({ pageSize: kept, currentPage: 1 });
    expect(out._truncated_message).toContain(`Only ${kept} of the 154 rows on this page`);
    expect(out._truncated_message).toContain(`pageSize ${kept} and currentPage 1`);
    expect(out._truncated_message).toContain("fields parameter");
    expect(out.totalItems).toBe(154);
  });

  it("following _next reads every row, with none skipped", () => {
    // Rows of uneven width, so a page size that fitted once does not always fit again.
    const uneven = Array.from({ length: 154 }, (_, i) => row(i, 12, 20 + (i % 7) * 25));
    const seen = new Set<string>();
    let call = { pageSize: 500, currentPage: 0 };
    let calls = 0;

    for (;;) {
      const out = fitListPage(platform(uneven, call.pageSize, call.currentPage)) as any;
      calls++;
      for (const item of out.list) seen.add(item.entryId);
      if (!out.hasMore) break;
      call = out._next ?? { pageSize: call.pageSize, currentPage: call.currentPage + 1 };
      expect(calls).toBeLessThan(40);
    }

    expect(seen.size).toBe(154);
  });

  it("a later page that is cut reads on from where it stopped", () => {
    const out = fitListPage(platform(wide, 100, 1)) as any; // rows 100..153, too many to send
    const kept = out.list.length;

    expect(kept).toBeLessThan(54);
    // 100 + kept is the first row left out; the page named starts at or just before it.
    const start = out._next.currentPage * out._next.pageSize;
    expect(start).toBeLessThanOrEqual(100 + kept);
    expect(start + out._next.pageSize).toBeGreaterThan(100 + kept);
  });

  it("one row too big for the budget is still returned, and the next call moves on", () => {
    const huge = [row(0, 3, 40_000), row(1, 3), row(2, 3)];

    const out = fitListPage(platform(huge, 500, 0)) as any;

    expect(out.list).toHaveLength(1);
    expect(out._next).toEqual({ pageSize: 1, currentPage: 1 });
  });

  it("leaves anything that is not a list page alone", () => {
    const entry = { entryId: 7, data: { Notes: "y".repeat(TRUNCATE_BUDGET * 2) } };
    expect(fitListPage(entry)).toBe(entry);
    expect((fitListPage(entry) as any)._truncated).toBeUndefined();
    expect(fitListPage(null)).toBeNull();
    const single = { list: [{ big: "z".repeat(TRUNCATE_BUDGET * 2) }], hasMore: false };
    expect((fitListPage(single) as any).hasMore).toBe(false);
  });
});
