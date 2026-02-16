import { ApiError } from "@/lib/api-error";
import {
  canonicalDmPair,
  normalizeMessageBody,
  resolvePageLimit,
} from "@/server/chat-service";

describe("chat-service unit helpers", () => {
  it("canonicalDmPair sorts user ids to one stable order", () => {
    expect(canonicalDmPair("u_carmen", "u_alex")).toEqual(["u_alex", "u_carmen"]);
    expect(canonicalDmPair("u_alex", "u_carmen")).toEqual(["u_alex", "u_carmen"]);
  });

  it("resolvePageLimit applies default and caps max size", () => {
    expect(resolvePageLimit(null)).toBe(50);
    expect(resolvePageLimit("25")).toBe(25);
    expect(resolvePageLimit("150")).toBe(50);
  });

  it("resolvePageLimit rejects invalid values", () => {
    expect(() => resolvePageLimit("0")).toThrow(ApiError);
    expect(() => resolvePageLimit("-1")).toThrow(ApiError);
    expect(() => resolvePageLimit("abc")).toThrow(ApiError);
  });

  it("normalizeMessageBody trims and validates size", () => {
    expect(normalizeMessageBody("  hello world  ")).toBe("hello world");
    expect(() => normalizeMessageBody("   ")).toThrow(ApiError);
    expect(() => normalizeMessageBody("a".repeat(2001))).toThrow(ApiError);
  });
});
