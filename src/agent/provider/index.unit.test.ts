import { resolveAgentProvider } from "@/agent/provider";

describe("agent provider selection", () => {
  const originalProvider = process.env.AI_PROVIDER;

  afterEach(() => {
    if (originalProvider === undefined) {
      delete process.env.AI_PROVIDER;
      return;
    }

    process.env.AI_PROVIDER = originalProvider;
  });

  it("defaults to anthropic when AI_PROVIDER is not set", () => {
    delete process.env.AI_PROVIDER;
    expect(resolveAgentProvider().name).toBe("anthropic");
  });

  it("supports explicit openai provider", () => {
    process.env.AI_PROVIDER = "openai";
    expect(resolveAgentProvider().name).toBe("openai");
  });

  it("falls back to mock for unknown provider", () => {
    process.env.AI_PROVIDER = "unknown";
    expect(resolveAgentProvider().name).toBe("mock");
  });
});
