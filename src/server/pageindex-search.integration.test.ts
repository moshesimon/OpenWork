import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";

type SearchPageIndexFn = (typeof import("@/server/pageindex-search"))["searchPageIndex"];

describe("pageindex-search integration", () => {
  let tempDir: string;
  let workspaceRoot: string;
  let searchPageIndex: SearchPageIndexFn;

  const originalWorkspaceRoot = process.env.WORKSPACE_FILES_ROOT;

  beforeAll(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "openwork-pageindex-search-"));
    workspaceRoot = path.join(tempDir, "workspace");
    await mkdir(workspaceRoot, { recursive: true });

    process.env.WORKSPACE_FILES_ROOT = workspaceRoot;

    vi.resetModules();
    ({ searchPageIndex } = await import("@/server/pageindex-search"));
  });

  beforeEach(async () => {
    await mkdir(path.join(workspaceRoot, "notes"), { recursive: true });
    await mkdir(path.join(workspaceRoot, "plans"), { recursive: true });
  });

  afterAll(() => {
    if (originalWorkspaceRoot === undefined) {
      delete process.env.WORKSPACE_FILES_ROOT;
    } else {
      process.env.WORKSPACE_FILES_ROOT = originalWorkspaceRoot;
    }

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns file matches from both path and content", async () => {
    const marker = "pageidxnebula";

    const pathMatchFile = path.join(workspaceRoot, "plans", `${marker}-handoff.md`);
    const contentMatchFile = path.join(workspaceRoot, "notes", "meeting.md");

    await writeFile(pathMatchFile, "Milestone checklist", "utf8");
    await writeFile(
      contentMatchFile,
      `This meeting captured ${marker} release details and action items.`,
      "utf8",
    );

    const payload = await searchPageIndex({
      query: marker,
      limit: 20,
    });

    expect(payload.total).toBeGreaterThanOrEqual(2);
    expect(payload.results.some((entry) => entry.filePath === `plans/${marker}-handoff.md`)).toBe(true);
    expect(payload.results.some((entry) => entry.filePath === "notes/meeting.md")).toBe(true);
    expect(payload.results.some((entry) => entry.filePath === "notes/meeting.md" && entry.snippet)).toBe(
      true,
    );
  });

  it("rejects too-short queries", async () => {
    await expect(
      searchPageIndex({
        query: "a",
      }),
    ).rejects.toMatchObject({
      errorCode: "INVALID_QUERY",
      status: 400,
    });
  });
});
