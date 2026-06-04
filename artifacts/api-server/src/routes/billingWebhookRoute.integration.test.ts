import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import request from "supertest";
import {
  db,
  processedStripeEventsTable,
  stripeSubscriptionsTable,
  usersTable,
} from "@workspace/db";
import { getUserPlan } from "../services/billingService";
import { truncateAll } from "../test/integration";
import { INTEGRATION_AVAILABLE } from "../test/setup";

/**
 * Integration coverage for the Stripe webhook ROUTE — POST /api/billing/webhook
 * and its `handleStripeWebhook` wrapper in app.ts — not just the
 * `WebhookHandlers.processWebhook` handler the sibling
 * webhookHandlers.integration.test.ts drives directly.
 *
 * The route is the convergent billing-trust surface: it's the ONLY way a plan is
 * mutated server-side, it's registered before express.json() (raw body for
 * signature verification), and it's hit by an at-least-once / unordered delivery
 * channel. So the regressions worth guarding end-to-end through HTTP are:
 *   - a missing `stripe-signature` header → 400, nothing written;
 *   - an INVALID signature (constructEvent throws) → 400, nothing written;
 *   - a valid event dispatches (the subscription cache is populated);
 *   - a REPLAYED event id is a no-op (processed_stripe_events dedup) but still
 *     200 (so Stripe stops retrying);
 *   - OUT-OF-ORDER delivery doesn't corrupt the derived plan:
 *       · a stale `deleted` arriving AFTER a newer `updated(active)` leaves the
 *         row a terminal tombstone (canceled), and
 *       · a stale `updated(active)` arriving AFTER a `deleted` does NOT resurrect
 *         Pro — getUserPlan stays "free".
 *
 * SIGNATURE VERIFICATION IS STUBBED AT THE STRIPE-CLIENT BOUNDARY: we mock
 * `./stripeClient`'s `getUncachableStripeClient` so `webhooks.constructEvent`
 * (a) parses the test-authored JSON payload as the event when the signature is
 * the sentinel "good-sig", and (b) THROWS (exactly as the real SDK does on a bad
 * HMAC) for anything else. This lets us exercise the route's real 400/200
 * branching, idempotency, and ordering guards without a real webhook secret —
 * everything downstream of constructEvent (dedup, dispatch, the monotonicity
 * guards, the DB) is the real code, driven end-to-end via supertest.
 */

const GOOD_SIG = "good-sig";

vi.mock("../stripeClient", () => ({
  getUncachableStripeClient: vi.fn(async () => ({
    webhooks: {
      constructEvent: (payload: Buffer, signature: string) => {
        if (signature !== GOOD_SIG) {
          // Mirror Stripe's real SDK: an unverifiable signature throws.
          throw new Error("Webhook signature verification failed");
        }
        return JSON.parse(payload.toString("utf8")) as Stripe.Event;
      },
    },
  })),
}));

// Imported AFTER the mock (vi.mock is hoisted) so app's webhook handler picks up
// the mocked Stripe client.
const app = (await import("../app")).default;

const SUB_ID = "sub_route_123";
const CUSTOMER_ID = "cus_route_abc";

beforeEach(async () => {
  await truncateAll();
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
});

function makeSub(
  overrides: Partial<Stripe.Subscription> = {},
): Stripe.Subscription {
  const base = {
    id: SUB_ID,
    customer: CUSTOMER_ID,
    status: "active",
    cancel_at_period_end: false,
    items: {
      data: [
        {
          id: "si_1",
          price: { id: "price_basic_monthly" },
          current_period_start: Math.floor(Date.now() / 1000) - 60,
          current_period_end: Math.floor(Date.now() / 1000) + 3600,
        },
      ],
    },
  } as unknown as Stripe.Subscription;
  return { ...base, ...overrides } as Stripe.Subscription;
}

function makeEvent(
  type: Stripe.Event.Type,
  sub: Stripe.Subscription,
  opts: { id?: string; created?: number } = {},
): Stripe.Event {
  return {
    id: opts.id ?? "evt_route_1",
    type,
    created: opts.created ?? Math.floor(Date.now() / 1000),
    data: { object: sub },
  } as unknown as Stripe.Event;
}

/**
 * POST a JSON event with the raw body the route expects.
 *
 * The body is sent as a STRING (not a Buffer) under Content-Type
 * application/json: superagent transmits an already-serialized string verbatim,
 * so express.raw({ type: "application/json" }) hands `processWebhook` the exact
 * bytes. (Passing a Buffer here would make superagent JSON-stringify it into
 * `{"type":"Buffer","data":[...]}`, corrupting the payload — and the real Stripe
 * SDK signs the raw JSON string anyway, so a string is the faithful shape.)
 */
function postEvent(event: Stripe.Event, signature: string | null) {
  const req = request(app)
    .post("/api/billing/webhook")
    .set("Content-Type", "application/json");
  if (signature !== null) req.set("Stripe-Signature", signature);
  return req.send(JSON.stringify(event));
}

async function readSub() {
  const [row] = await db
    .select()
    .from(stripeSubscriptionsTable)
    .where(eq(stripeSubscriptionsTable.id, SUB_ID));
  return row;
}

/** Insert a user owning CUSTOMER_ID so getUserPlan reflects the cache. */
async function createUserForCustomer(): Promise<string> {
  const [row] = await db
    .insert(usersTable)
    .values({
      email: `webhook-${Date.now()}-${Math.random()}@test.local`,
      stripeCustomerId: CUSTOMER_ID,
    })
    .returning();
  return row.id;
}

describe.runIf(INTEGRATION_AVAILABLE)(
  "POST /api/billing/webhook — signature gate",
  () => {
    it("400s when the stripe-signature header is missing (nothing written)", async () => {
      const res = await postEvent(
        makeEvent("customer.subscription.created", makeSub()),
        null,
      );

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "Missing stripe-signature" });
      expect(await readSub()).toBeUndefined();
    });

    it("400s when the signature is invalid (constructEvent throws; nothing written)", async () => {
      const res = await postEvent(
        makeEvent("customer.subscription.created", makeSub()),
        "t=1,v1=forged",
      );

      expect(res.status).toBe(400);
      // The handler maps any processing error to a generic 400 body.
      expect(res.body).toEqual({ error: "Webhook processing error" });
      // The cache was never touched, and the event id was never recorded (so a
      // legitimately-signed retry can still be applied).
      expect(await readSub()).toBeUndefined();
      const ledger = await db.select().from(processedStripeEventsTable);
      expect(ledger).toHaveLength(0);
    });
  },
);

describe.runIf(INTEGRATION_AVAILABLE)(
  "POST /api/billing/webhook — valid dispatch + replay",
  () => {
    it("dispatches a valid event, populates the cache, and flips the plan to pro", async () => {
      const userId = await createUserForCustomer();
      expect(await getUserPlan(CUSTOMER_ID)).toBe("free"); // baseline

      const res = await postEvent(
        makeEvent("customer.subscription.created", makeSub(), {
          id: "evt_dispatch_1",
          created: 1000,
        }),
        GOOD_SIG,
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });

      const row = await readSub();
      expect(row).toBeDefined();
      expect(row.status).toBe("active");
      expect(row.customerId).toBe(CUSTOMER_ID);

      // The event id is recorded for idempotency.
      const [ledger] = await db
        .select()
        .from(processedStripeEventsTable)
        .where(eq(processedStripeEventsTable.id, "evt_dispatch_1"));
      expect(ledger).toBeDefined();

      // Plan derivation now sees the active sub.
      expect(await getUserPlan(CUSTOMER_ID)).toBe("pro");
      void userId;
    });

    it("no-ops a replayed event id (dedup) but still 200s", async () => {
      // First delivery: created(active), event id evt_replay_route.
      const first = await postEvent(
        makeEvent("customer.subscription.created", makeSub(), {
          id: "evt_replay_route",
          created: 1000,
        }),
        GOOD_SIG,
      );
      expect(first.status).toBe(200);
      expect((await readSub()).status).toBe("active");

      // A redelivery carrying the SAME event id but a logically-newer cancel must
      // be skipped wholesale (dedup runs before dispatch), yet still return 200 so
      // Stripe stops retrying.
      const replay = await postEvent(
        makeEvent(
          "customer.subscription.updated",
          makeSub({ status: "canceled" as Stripe.Subscription.Status }),
          { id: "evt_replay_route", created: 5000 },
        ),
        GOOD_SIG,
      );
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual({ received: true });

      // The replay changed nothing — the row is still active.
      expect((await readSub()).status).toBe("active");
    });
  },
);

describe.runIf(INTEGRATION_AVAILABLE)(
  "POST /api/billing/webhook — out-of-order delivery (plan integrity)",
  () => {
    it("a stale deleted after a newer updated(active) leaves a terminal tombstone", async () => {
      await createUserForCustomer();

      // Newer updated(active) lands first.
      const active = await postEvent(
        makeEvent("customer.subscription.updated", makeSub({ status: "active" }), {
          id: "evt_active_newer",
          created: 2000,
        }),
        GOOD_SIG,
      );
      expect(active.status).toBe(200);
      expect(await getUserPlan(CUSTOMER_ID)).toBe("pro");

      // A logically-OLDER deleted arrives afterwards. deleteSubscription treats
      // the cancellation as terminal regardless of relative timestamp (Stripe
      // never re-activates a deleted id), so the row tombstones to canceled.
      const deleted = await postEvent(
        makeEvent("customer.subscription.deleted", makeSub(), {
          id: "evt_deleted_older",
          created: 1000,
        }),
        GOOD_SIG,
      );
      expect(deleted.status).toBe(200);

      const row = await readSub();
      expect(row.status).toBe("canceled");
      expect(row.deletedAt).not.toBeNull();
      // Plan correctly reflects the cancellation.
      expect(await getUserPlan(CUSTOMER_ID)).toBe("free");
    });

    it("a stale updated(active) after a deleted does NOT resurrect Pro", async () => {
      await createUserForCustomer();

      // deleted arrives first (logically older).
      const deleted = await postEvent(
        makeEvent("customer.subscription.deleted", makeSub(), {
          id: "evt_deleted_first",
          created: 1000,
        }),
        GOOD_SIG,
      );
      expect(deleted.status).toBe(200);
      expect(await getUserPlan(CUSTOMER_ID)).toBe("free");

      // A later-delivered but logically-newer updated(active) must NOT undo the
      // terminal tombstone: upsertSubscription refuses to overwrite a deletedAt
      // row. This is the security-critical assertion — a paying-then-canceled
      // user must not be silently re-granted Pro by a late event.
      const resurrect = await postEvent(
        makeEvent("customer.subscription.updated", makeSub({ status: "active" }), {
          id: "evt_active_later",
          created: 2000,
        }),
        GOOD_SIG,
      );
      expect(resurrect.status).toBe(200); // still 200 (handled, just skipped)

      const row = await readSub();
      expect(row.status).toBe("canceled");
      expect(row.deletedAt).not.toBeNull();
      expect(await getUserPlan(CUSTOMER_ID)).toBe("free");
    });
  },
);
