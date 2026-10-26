import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const scripts = join(import.meta.dirname, "..", "scripts");

describe("install scripts", () => {
  // Windows PowerShell 5.1 reads a BOM-less file as the system ANSI code page: Chinese text turns into mojibake and the script fails to parse
  it("every .ps1 that has non-ASCII text starts with a UTF-8 BOM", () => {
    for (const name of readdirSync(scripts).filter((n) => n.endsWith(".ps1"))) {
      const bytes = readFileSync(join(scripts, name));
      if (!bytes.some((b) => b > 0x7f)) continue;
      assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${name} has no UTF-8 BOM`);
    }
  });
});
