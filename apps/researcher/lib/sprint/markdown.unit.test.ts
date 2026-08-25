import assert from "node:assert/strict";
import test from "node:test";
import { buildSprintMarkdown, sprintFileName } from "./markdown";

const sprint = {
  title: "Erasure Code Research Report",
  summary: "A short summary.",
  reportContent: "## Findings\n\nErasure codes are FEC codes.",
  createdAt: "2026-08-17T11:59:52.298Z",
  citations: [
    {
      refIndex: 1,
      sourceTitle: "Erasure Code — Wikipedia",
      sourceUrl: "https://en.wikipedia.org/wiki/Erasure_code",
      section: "Optimal erasure codes",
    },
    {
      refIndex: 2,
      sourceTitle: "Offline PDF",
      sourceUrl: null,
      section: "Intro",
    },
  ],
};

test("buildSprintMarkdown assembles title, summary, report, and references", () => {
  const md = buildSprintMarkdown(sprint);

  assert.ok(md.startsWith("# Erasure Code Research Report\n"));
  assert.ok(md.includes("A short summary."));
  assert.ok(md.includes("## Findings"));
  assert.ok(md.includes("Erasure codes are FEC codes."));
  assert.ok(md.includes("## References"));
  assert.ok(
    md.includes(
      "[1] Erasure Code — Wikipedia — Optimal erasure codes (https://en.wikipedia.org/wiki/Erasure_code)"
    )
  );
  // A citation without a URL still renders, without a dangling "(null)"
  assert.ok(md.includes("[2] Offline PDF — Intro"));
  assert.ok(!md.includes("null"));
});

test("buildSprintMarkdown omits empty sections instead of leaving headers", () => {
  const md = buildSprintMarkdown({
    title: "Bare",
    summary: null,
    reportContent: null,
    createdAt: sprint.createdAt,
    citations: [],
  });

  assert.equal(md.includes("## References"), false);
  assert.ok(md.startsWith("# Bare"));
  // No triple blank lines from skipped sections
  assert.equal(md.includes("\n\n\n"), false);
});

test("sprintFileName slugs the title into a safe .md name", () => {
  assert.equal(
    sprintFileName("Erasure Code: Research / Report?"),
    "erasure-code-research-report.md"
  );
  assert.equal(sprintFileName("   "), "sprint-report.md");
});
