import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// `server-only` throws outside a React Server Components build; tests import server modules directly.
vi.mock("server-only", () => ({}));
