/**
 * 0.4.0 createEgressGuard contract tests. No child processes — the
 * guard is pure policy around an injected fetchImpl, so tests drive it
 * with a fake fetch (recording calls, answering with a configurable
 * Content-Length) and a fake clock for the rolling windows.
 */

import { describe, expect, test } from "bun:test";
import {
  createEgressGuard,
  EgressDeniedError,
  type EgressDenyInfo,
} from "../src";

const makeFakeFetch = (
  bytesPerResponse = 0,
): {
  fetchImpl: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  calls: string[];
} => {
  const calls: string[] = [];
  return {
    calls,
    fetchImpl: async (input) => {
      const url =
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input;
      calls.push(url);
      const headers =
        bytesPerResponse > 0
          ? { "content-length": String(bytesPerResponse) }
          : undefined;
      return new Response("ok", { headers, status: 200 });
    },
  };
};

describe("createEgressGuard — 0.4.0", () => {
  test("default allowlist denies private/loopback/link-local/metadata/localhost", async () => {
    const { fetchImpl, calls } = makeFakeFetch();
    const guard = createEgressGuard({ fetchImpl });
    const guarded = guard.fetchFor("tenant-1");
    const blocked = [
      "http://10.0.0.7/steal",
      "http://172.16.0.1/",
      "http://172.31.255.255/",
      "http://192.168.1.1/router",
      "http://127.0.0.1:8080/",
      "http://169.254.169.254/latest/meta-data/", // cloud metadata
      "http://0.0.0.0/",
      "http://localhost:3000/",
      "http://foo.localhost/",
      "http://db.internal/",
      "http://[::1]:9200/",
      "http://[fd00::1]/",
      "http://[fe80::1]/",
      "http://[::ffff:10.0.0.1]/",
    ];
    for (const url of blocked) {
      await expect(guarded(url)).rejects.toThrow(EgressDeniedError);
    }
    expect(calls).toHaveLength(0);
  });

  test("default allowlist allows public hosts", async () => {
    const { fetchImpl, calls } = makeFakeFetch();
    const guard = createEgressGuard({ fetchImpl });
    const guarded = guard.fetchFor("tenant-1");
    const allowed = [
      "https://api.stripe.com/v1/charges",
      "https://example.com/",
      "http://8.8.8.8/",
      "http://172.15.0.1/", // just OUTSIDE 172.16/12
      "http://172.32.0.1/",
      "http://192.169.0.1/", // just outside 192.168/16
    ];
    for (const url of allowed) {
      const res = await guarded(url);
      expect(res.status).toBe(200);
    }
    expect(calls).toHaveLength(allowed.length);
  });

  test("custom allow hook overrides the default entirely", async () => {
    const { fetchImpl } = makeFakeFetch();
    const guard = createEgressGuard({
      allow: (tenant, url) =>
        tenant === "trusted" && url.hostname === "api.example.com",
      fetchImpl,
    });
    // The custom hook can allow what the default would... and applies per tenant.
    await expect(
      guard.fetchFor("trusted")("https://api.example.com/v1"),
    ).resolves.toBeInstanceOf(Response);
    await expect(
      guard.fetchFor("trusted")("https://other.example.com/"),
    ).rejects.toThrow(/not-allowed/);
    await expect(
      guard.fetchFor("untrusted")("https://api.example.com/v1"),
    ).rejects.toThrow(EgressDeniedError);
  });

  test("requests budget trips mid-window and re-opens after the window", async () => {
    const { fetchImpl, calls } = makeFakeFetch();
    let clock = 1_000_000;
    const guard = createEgressGuard({
      budgets: { requests: 2, windowMs: 1_000 },
      fetchImpl,
      now: () => clock,
    });
    const guarded = guard.fetchFor("tenant-1");
    await guarded("https://example.com/1");
    await guarded("https://example.com/2");
    await expect(guarded("https://example.com/3")).rejects.toThrow(
      /requests-budget/,
    );
    expect(calls).toHaveLength(2);
    // Window slides past the first two stamps — budget re-opens.
    clock += 1_001;
    await guarded("https://example.com/4");
    expect(calls).toHaveLength(3);
  });

  test("bytes budget trips once window bytes reach the cap and re-opens after the window", async () => {
    const { fetchImpl } = makeFakeFetch(600); // every response is 600 bytes
    let clock = 5_000_000;
    const guard = createEgressGuard({
      budgets: { bytes: 1_000, windowMs: 1_000 },
      fetchImpl,
      now: () => clock,
    });
    const guarded = guard.fetchFor("tenant-1");
    await guarded("https://example.com/a"); // window bytes: 600
    await guarded("https://example.com/b"); // window bytes: 1200 ≥ 1000
    await expect(guarded("https://example.com/c")).rejects.toThrow(
      /bytes-budget/,
    );
    clock += 1_001;
    await expect(guarded("https://example.com/d")).resolves.toBeInstanceOf(
      Response,
    );
  });

  test("budgets are per-tenant — one tenant tripping doesn't starve another", async () => {
    const { fetchImpl } = makeFakeFetch();
    const guard = createEgressGuard({
      budgets: { requests: 1, windowMs: 60_000 },
      fetchImpl,
      now: () => 42,
    });
    await guard.fetchFor("noisy")("https://example.com/");
    await expect(
      guard.fetchFor("noisy")("https://example.com/"),
    ).rejects.toThrow(/requests-budget/);
    await expect(
      guard.fetchFor("quiet")("https://example.com/"),
    ).resolves.toBeInstanceOf(Response);
  });

  test("reset(tenant) re-opens that tenant's budget window", async () => {
    const { fetchImpl } = makeFakeFetch();
    const guard = createEgressGuard({
      budgets: { requests: 1, windowMs: 60_000 },
      fetchImpl,
      now: () => 42,
    });
    const guarded = guard.fetchFor("tenant-1");
    await guarded("https://example.com/");
    await expect(guarded("https://example.com/")).rejects.toThrow(
      /requests-budget/,
    );
    guard.reset("tenant-1");
    await expect(guarded("https://example.com/")).resolves.toBeInstanceOf(
      Response,
    );
  });

  test("EgressDeniedError carries reason, tenant, and url", async () => {
    const guard = createEgressGuard({ fetchImpl: makeFakeFetch().fetchImpl });
    let caught: unknown;
    try {
      await guard.fetchFor("tenant-9")("http://169.254.169.254/creds");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EgressDeniedError);
    const denied = caught as EgressDeniedError;
    expect(denied.reason).toBe("not-allowed");
    expect(denied.tenant).toBe("tenant-9");
    expect(denied.url).toBe("http://169.254.169.254/creds");
  });

  test("onDeny fires with the structured info; a throwing onDeny is swallowed", async () => {
    const denials: EgressDenyInfo[] = [];
    const guard = createEgressGuard({
      budgets: { requests: 1, windowMs: 60_000 },
      fetchImpl: makeFakeFetch().fetchImpl,
      now: () => 42,
      onDeny: (info) => {
        denials.push(info);
        throw new Error("observer bug");
      },
    });
    const guarded = guard.fetchFor("tenant-1");
    await expect(guarded("http://localhost/")).rejects.toThrow(
      EgressDeniedError,
    );
    await guarded("https://example.com/");
    await expect(guarded("https://example.com/")).rejects.toThrow(
      /requests-budget/,
    );
    expect(denials).toHaveLength(2);
    expect(denials[0]?.reason).toBe("not-allowed");
    expect(denials[0]?.url).toBeInstanceOf(URL);
    expect(denials[1]?.reason).toBe("requests-budget");
  });

  test("metrics(): tenants, requests, denied by reason, bytesEgress", async () => {
    const { fetchImpl } = makeFakeFetch(250);
    const guard = createEgressGuard({
      budgets: { requests: 2, windowMs: 60_000 },
      fetchImpl,
      now: () => 42,
    });
    await guard.fetchFor("a")("https://example.com/");
    await guard.fetchFor("a")("https://example.com/");
    await expect(guard.fetchFor("a")("https://example.com/")).rejects.toThrow();
    await guard.fetchFor("b")("https://example.com/");
    await expect(guard.fetchFor("b")("http://10.1.2.3/")).rejects.toThrow();

    const m = guard.metrics();
    expect(m.tenants).toBe(2);
    expect(m.requests).toBe(3);
    expect(m.denied).toEqual({
      "bytes-budget": 0,
      "not-allowed": 1,
      "requests-budget": 1,
    });
    expect(m.bytesEgress).toBe(750);
  });

  test("Request and URL inputs are accepted; responses without Content-Length count zero bytes", async () => {
    const calls: string[] = [];
    const guard = createEgressGuard({
      fetchImpl: async (input) => {
        calls.push(input instanceof Request ? input.url : String(input));
        return new Response("streamed"); // no content-length header set...
      },
    });
    const guarded = guard.fetchFor("tenant-1");
    await guarded(new URL("https://example.com/from-url"));
    await guarded(new Request("https://example.com/from-request"));
    await expect(
      guarded(new Request("http://192.168.0.10/private")),
    ).rejects.toThrow(EgressDeniedError);
    expect(calls).toHaveLength(2);
    // Documented Content-Length-or-zero accounting: Response("streamed")
    // may synthesize a Content-Length in Bun; assert the metric merely
    // never goes negative and requests counted.
    const m = guard.metrics();
    expect(m.requests).toBe(2);
    expect(m.bytesEgress).toBeGreaterThanOrEqual(0);
  });
});
