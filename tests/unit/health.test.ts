import { expect, it } from "vitest";
import { GET } from "@/app/api/health/route";

it("health returns 200 with version and commit", async () => {
  const res = GET();
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ status: "ok" });
  expect(body).toHaveProperty("version");
  expect(body).toHaveProperty("commit");
});
