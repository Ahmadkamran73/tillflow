import { describe, expect, it } from "vitest";
import { safeNext } from "@/lib/auth/redirect";
import {
  mfaEnrolVerifyInput,
  resetPasswordInput,
  signInInput,
  signUpInput,
  totpCodeInput,
} from "@/lib/auth/schemas";

const good = {
  email: "Owner@Example.ie ",
  password: "Correct-horse-9",
  businessName: " Corner Shop ",
};

describe("signUpInput", () => {
  it("trims and lower-cases the email and trims the business name", () => {
    const r = signUpInput.parse(good);
    expect(r.email).toBe("owner@example.ie");
    expect(r.businessName).toBe("Corner Shop");
  });

  it.each([
    ["short", "Ab1"],
    ["no digit", "Correct-horse-nine"],
    ["no upper-case", "correct-horse-9"],
    ["no lower-case", "CORRECT-HORSE-9"],
    ["over 72 characters", "Aa1".repeat(25)],
  ])("rejects a password that is %s", (_name, password) => {
    expect(signUpInput.safeParse({ ...good, password }).success).toBe(false);
  });

  it("rejects a bad email and an empty or oversized business name", () => {
    expect(signUpInput.safeParse({ ...good, email: "nope" }).success).toBe(false);
    expect(signUpInput.safeParse({ ...good, businessName: "   " }).success).toBe(false);
    expect(signUpInput.safeParse({ ...good, businessName: "x".repeat(121) }).success).toBe(false);
  });
});

describe("other inputs", () => {
  it("sign-in does not apply the strength rules to an existing password", () => {
    expect(signInInput.safeParse({ email: "a@b.ie", password: "old" }).success).toBe(true);
  });

  it("reset requires matching passwords", () => {
    expect(
      resetPasswordInput.safeParse({ password: "Correct-horse-9", confirmPassword: "different" })
        .success,
    ).toBe(false);
    expect(
      resetPasswordInput.safeParse({
        password: "Correct-horse-9",
        confirmPassword: "Correct-horse-9",
      }).success,
    ).toBe(true);
  });

  it("TOTP codes are exactly six digits", () => {
    expect(totpCodeInput.safeParse({ code: " 123456 " }).success).toBe(true);
    for (const code of ["12345", "1234567", "12345a", ""]) {
      expect(totpCodeInput.safeParse({ code }).success).toBe(false);
    }
  });

  it("MFA enrolment needs a uuid factor id", () => {
    expect(mfaEnrolVerifyInput.safeParse({ code: "123456", factorId: "x" }).success).toBe(false);
    expect(
      mfaEnrolVerifyInput.safeParse({
        code: "123456",
        factorId: "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
      }).success,
    ).toBe(true);
  });
});

describe("safeNext", () => {
  it("keeps same-site relative paths", () => {
    expect(safeNext("/o/abc/dashboard?x=1")).toBe("/o/abc/dashboard?x=1");
  });

  it.each([
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "javascript:alert(1)",
    "o/relative",
    "/ok\nHost: evil",
    "/back\\slash",
    "",
    undefined,
    42,
  ])("falls back for %j", (value) => {
    expect(safeNext(value)).toBe("/o");
    expect(safeNext(value, "/onboarding")).toBe("/onboarding");
  });
});
