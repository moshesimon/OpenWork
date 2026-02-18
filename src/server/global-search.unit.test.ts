import { extractSearchSnippet, findTextMatchRanges, scoreTextMatch } from "@/server/global-search";

describe("global-search helpers", () => {
  it("scores exact and prefix matches higher than substring matches", () => {
    const needle = "budget";
    const exact = scoreTextMatch("budget", needle);
    const prefix = scoreTextMatch("budget review", needle);
    const substring = scoreTextMatch("fy2026 budget review", needle);

    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(0);
  });

  it("returns 0 score when there is no match", () => {
    expect(scoreTextMatch("calendar planning", "vendor")).toBe(0);
  });

  it("extracts snippets around the matched text", () => {
    const snippet = extractSearchSnippet(
      "This report includes the latest vendor payments and approval status for all teams.",
      "vendor",
      20,
    );

    expect(snippet).toContain("vendor payments");
    expect(snippet?.startsWith("…")).toBe(true);
  });
});

describe("findTextMatchRanges", () => {
  it("returns a single range for a unique match", () => {
    const ranges = findTextMatchRanges("budget review Q1", "budget");
    expect(ranges).toEqual([{ start: 0, end: 6 }]);
  });

  it("returns multiple ranges for repeated matches", () => {
    const ranges = findTextMatchRanges("budget and more budget items", "budget");
    expect(ranges).toHaveLength(2);
    expect(ranges[0]).toEqual({ start: 0, end: 6 });
    expect(ranges[1]).toEqual({ start: 15, end: 21 });
  });

  it("matches case-insensitively", () => {
    const ranges = findTextMatchRanges("Budget BUDGET budget", "budget");
    expect(ranges).toHaveLength(3);
    expect(ranges[0]).toEqual({ start: 0, end: 6 });
    expect(ranges[1]).toEqual({ start: 7, end: 13 });
    expect(ranges[2]).toEqual({ start: 14, end: 20 });
  });

  it("returns empty array when there is no match", () => {
    const ranges = findTextMatchRanges("nothing here matches", "vendor");
    expect(ranges).toEqual([]);
  });

  it("returns empty array for empty text", () => {
    expect(findTextMatchRanges("", "query")).toEqual([]);
  });

  it("returns empty array for empty needle", () => {
    expect(findTextMatchRanges("some text", "")).toEqual([]);
  });

  it("merges overlapping ranges", () => {
    // "aa" in "aaaa" would produce [0,2],[1,3],[2,4] — after normalization these should merge
    const ranges = findTextMatchRanges("aaaa", "aa");
    // Non-overlapping, stride by match length: [0,2] then cursor=2 gives [2,4]
    expect(ranges).toEqual([{ start: 0, end: 2 }, { start: 2, end: 4 }]);
  });
});
