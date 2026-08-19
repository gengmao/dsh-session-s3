import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function load(name: string): string {
  return readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
}

describe("cordis yaml", () => {
  it("cordis.patch.yml is standard YAML with no !!js tags", () => {
    const text = load("cordis.patch.yml");
    expect(text).not.toMatch(/!!js\s+process\.env/);
    expect(text).toMatch(/^- id: sessions$/m);
    expect(text).toMatch(/^  name: dsh-session-s3$/m);
    expect(text).toMatch(/bucket: my-sessions/);
  });

  it("cordis.yml plugin id is dsh-session-persistence-s3 and name is dsh-session-s3", () => {
    const text = load("cordis.yml");
    expect(text).not.toMatch(/!!/);
    expect(text).toMatch(/^id: dsh-session-persistence-s3$/m);
    expect(text).toMatch(/^name: dsh-session-s3$/m);
  });
});
