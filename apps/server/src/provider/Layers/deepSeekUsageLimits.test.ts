import { describe, expect, it } from "vite-plus/test";

import { findOpenCodeGoApiKeyEnv, readCredentialRef } from "./deepSeekUsageLimits.ts";

const patch = (apiKeyEnv: string) => `
- id: ui-settings-general
  config:
    welcomeNoticeVersion: 1
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      opencode-go:
        apiKeyEnv: ${apiKeyEnv}
`;

describe("deepSeekUsageLimits", () => {
  it("finds the env var the opencode-go provider reads its key from", () => {
    expect(findOpenCodeGoApiKeyEnv(["[]", patch("MY_GO_KEY")])).toBe("MY_GO_KEY");
    expect(findOpenCodeGoApiKeyEnv(["not: [valid", "[]"])).toBe("OPENCODE_GO_API_KEY");
    expect(findOpenCodeGoApiKeyEnv([])).toBe("OPENCODE_GO_API_KEY");
  });

  it("reads a key reference from dsh's credential store", () => {
    const store = "version: 1\nrefs:\n  MY_GO_KEY: secret-value\n  EMPTY: ''\n";
    expect(readCredentialRef(store, "MY_GO_KEY")).toBe("secret-value");
    expect(readCredentialRef(store, "EMPTY")).toBeUndefined();
    expect(readCredentialRef(store, "MISSING")).toBeUndefined();
    expect(readCredentialRef("{{ broken", "MY_GO_KEY")).toBeUndefined();
  });
});
