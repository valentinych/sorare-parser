import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  expected11GazetteFile,
  expected11GazetteFileName,
  expected11GazetteView,
} from "./expected11Gazette.js";

const TINY_PDF = Buffer.from("%PDF-1.7\ntrailer<<>>\n%%EOF\n", "latin1");

function gazetteDir(): string {
  return mkdtempSync(path.join(tmpdir(), "expected11-gazette-"));
}

test("gazette lookup keys Ekstraklasa tour PDFs and ignores missing tours", () => {
  const dir = gazetteDir();
  writeFileSync(path.join(dir, "ekstraklasa-5.pdf"), TINY_PDF);
  writeFileSync(path.join(dir, "not-a-pdf.pdf"), "hello");

  assert.equal(expected11GazetteFileName("ekstraklasa", 5), "ekstraklasa-5.pdf");
  assert.equal(
    expected11GazetteFile("ekstraklasa", 5, dir),
    path.join(dir, "ekstraklasa-5.pdf"),
  );
  assert.equal(expected11GazetteFile("championship", 5, dir), null);
  assert.equal(expected11GazetteFile("ekstraklasa", 4, dir), null);
  assert.equal(expected11GazetteFile("ekstraklasa", 5, gazetteDir()), null);
  assert.equal(expected11GazetteFile("../ekstraklasa", 5, dir), null);
  assert.equal(expected11GazetteFile("ekstraklasa", 0, dir), null);
  assert.match(
    expected11GazetteView("ekstraklasa", 5, dir)?.url || "",
    /^\/api\/expected11\/gazette\/ekstraklasa\/5\?v=\d+$/,
  );
  assert.equal(expected11GazetteView("ekstraklasa", null, dir), null);
  assert.equal(expected11GazetteView("championship", 3, dir), null);
});
