import { describe, expect, it } from "vitest";
import { PassportService, REVOCATIONS_TICK, secretKeyring } from "../../src/identity/index.js";
import { outboundServiceAuth } from "../../src/impl/auth/audited-auth.js";
import { DELIVERY_COMPLETED } from "../../src/outbound/topics/deliveries-results.topic.js";
import { ControllerRole } from "../../src/runtime/roles/controller-role.js";
import { ManualTickGenerator } from "../../src/shared/ticks/plugins/manual/manual-tick-generator.js";
import { FakeAuth, cleanScanner, pipeline, silent } from "../helpers/fakes.js";

// RFC 0015 §8 (M9): outbound sends under its service passport. Every write is `use_tool` on its target by
// `service:outbound`, audited; a refused one is not sent. These fail if outbound writes with no decision, under
// another principal, or past a refusal.

const KEY = { get: async () => ({ reveal: () => "k".repeat(40) }) };
type F = Awaited<ReturnType<typeof pipeline>>;

/** A controller on the pipeline's store whose outbound decides each write through `outbound_auth`. */
function controllerWith(f: F, outbound_auth: NonNullable<ConstructorParameters<typeof ControllerRole>[0]["outbound_auth"]>) {
  return new ControllerRole({
    store: f.store, source: f.source, forge: f.forge, auth: new FakeAuth(), clock: f.clock, config: f.config, log: silent,
    scanner: cleanScanner, outbound_auth,
  });
}

/** Triage and implement on w1, the results applied by `c`, whose outbound delivers the implement run's push and PR. */
async function implemented(f: F, c: ControllerRole) {
  const it0 = await f.submit();
  await f.w1.tick();
  await c.tickRuns();
  await f.w1.tick();
  await c.tickRuns();
  return it0;
}

describe("outbound's service passport", () => {
  it("each write is use_tool on its target by service:outbound, audited, and the item advances", async () => {
    const f = await pipeline();
    const ticks = new ManualTickGenerator();
    let n = 0;
    const identity = new PassportService({
      db: f.store.db, keys: secretKeyring(KEY, { current: "K" }), providers: [], grants: [], ticks, newId: () => `pp_${++n}`,
    });
    await ticks.tick(REVOCATIONS_TICK, f.clock.now().getTime());
    const it0 = await implemented(f, controllerWith(f, outboundServiceAuth(identity)));
    expect(await f.item(it0)).toMatchObject({ stage: "REVIEW", change_ref: "42" });
    const audit = await f.store.db.all("SELECT principal, action, decision FROM authz_audit WHERE principal = 'service:outbound' ORDER BY seq");
    expect(audit.length).toBeGreaterThanOrEqual(2); // at least the push and the PR
    expect(new Set(audit.map((r) => `${String(r.principal)} ${String(r.action)} ${String(r.decision)}`))).toEqual(new Set(["service:outbound use_tool allow"]));
    // DeliveryCompleted names the passport the batch was sent under.
    const outboundPassport = (await identity.service("outbound")).passport.id;
    const completed = (await f.store.db.all("SELECT envelope FROM outbound_outbox"))
      .map((r) => JSON.parse(String(r.envelope)) as { type: string; subject: string; passport_id: string | null })
      // The push and the PR (`f.submit` flushed the intake's label with the pipeline's own controller).
      .filter((e) => e.type === DELIVERY_COMPLETED && e.subject.startsWith("git:"));
    expect(completed.length).toBeGreaterThan(0);
    expect(new Set(completed.map((e) => e.passport_id))).toEqual(new Set([outboundPassport]));
  });

  it("a refused write is not sent and retries; once allowed it goes out", async () => {
    const f = await pipeline();
    const asked: string[] = [];
    let allow = false;
    const c = controllerWith(f, async (_project, target) => {
      asked.push(target);
      return { passport_id: "pp_out", decision: allow ? { allow: true } : { allow: false, reason: "revoked" } };
    });
    const it0 = await implemented(f, c);
    expect(asked).toContain("github-push");
    expect(f.forge.pushes).toEqual([]);
    expect(await f.item(it0)).toMatchObject({ stage: "RUNNING", blocked_on: "outbound", blocked_reason: "pr_pending" });
    allow = true;
    f.clock.advance(f.config.retry_max_ms);
    await c.tickOutbox();
    expect(f.forge.pushes).toHaveLength(1);
    expect(f.forge.prOpens).toHaveLength(1);
    expect(await f.item(it0)).toMatchObject({ stage: "REVIEW", change_ref: "42" });
  });
});
