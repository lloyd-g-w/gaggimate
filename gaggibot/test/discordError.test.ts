import { describe, expect, it } from "vitest";
import { describeDiscordError } from "../src/discordBot.js";

/**
 * A bad token or a disabled privileged intent used to crash-loop the container. These are the
 * messages the user actually saw, and they must become actionable text plus a service that stays up.
 */
describe("describeDiscordError", () => {
  it("explains the privileged-intent failure the portal causes", () => {
    const message = describeDiscordError(new Error("Used disallowed intents"));
    expect(message).toContain("Message Content Intent");
    expect(message).toContain("Privileged Gateway Intents");
  });
  it("explains an invalid token", () => {
    expect(describeDiscordError(new Error("An invalid token was provided"))).toContain("Reset Token");
  });
  it("explains a network failure", () => {
    expect(describeDiscordError(new Error("getaddrinfo ENOTFOUND discord.com"))).toContain("DNS");
  });
  it("falls back to the raw message for anything else", () => {
    expect(describeDiscordError(new Error("something odd"))).toBe("something odd");
    expect(describeDiscordError("a string")).toBe("a string");
  });
});
