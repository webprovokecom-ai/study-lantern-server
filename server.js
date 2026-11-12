import express from "express";
import { stripe, STUDENT_PRICE_KEY, SCHOOL_PRICE_KEY } from "./stripe.js";
import * as store from "./db.js";
import { makeCode } from "./activation.js";

const app = express();
const PUBLIC_URL = process.env.PUBLIC_URL || "http://localhost:4242";
const ACCESS_STATUSES = ["active", "trialing", "past_due"]; // past_due keeps access while Stripe retries the card
const CHECKOUT_LABEL = "study-lantern-student-qhzmtwke"; // tags these sessions in the Dashboard

async function priceFor(lookupKey) {
  const { data } = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  if (!data.length) throw new Error(`No price with lookup key ${lookupKey}. Run "npm run setup" first.`);
  return data[0];
}

/* ---------------- Webhook (must read the raw body, so it comes before express.json) ---------------- */

// Keep our copy of a subscription in step with Stripe
async function syncSubscription(subscriptionOrId, db) {
  const sub = typeof subscriptionOrId === "string" ? await stripe.subscriptions.retrieve(subscriptionOrId) : subscriptionOrId;
  const item = sub.items?.data?.[0];
  const rec = (db.customers[sub.customer] ||= {});
  Object.assign(rec, {
    subscriptionId: sub.id,
    status: sub.status,
    currentPeriodEnd: item?.current_period_end ?? null,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    currency: sub.currency,
  });
  return rec;
}

// Refunds, disputes and fraud warnings point at a PaymentIntent; walk to its invoice and subscription
async function subscriptionForPaymentIntent(paymentIntentId) {
  if (!paymentIntentId) return null;
  const { data } = await stripe.invoicePayments.list({ payment: { type: "payment_intent", payment_intent: paymentIntentId }, limit: 1 });
  const invoiceId = data[0] && (typeof data[0].invoice === "string" ? data[0].invoice : data[0].invoice?.id);
  if (!invoiceId) return null;
  const invoice = await stripe.invoices.retrieve(invoiceId);
  return invoice.parent?.subscription_details?.subscription ?? null;
}

app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
  } catch {
    return res.status(400).send("Webhook signature check failed");
  }

  await store.withLock(() => handleEvent(event, res));
});

async function handleEvent(event, res) {
  const db = (await store.load());
  if (db.processedEvents.includes(event.id)) return res.json({ received: true, duplicate: true });

  try {
    const obj = event.data.object;
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        if (obj.mode !== "subscription") break;
        // Link our user to the Stripe customer that Checkout created or used
        if (obj.client_reference_id && obj.customer) {
          db.users[obj.client_reference_id] = { ...(db.users[obj.client_reference_id] || {}), customerId: obj.customer, email: obj.customer_details?.email ?? null };
          (db.customers[obj.customer] ||= {}).userId = obj.client_reference_id;
        }
        // Only grant access once the payment is actually through
        if (obj.payment_status !== "unpaid" && obj.subscription) await syncSubscription(obj.subscription, db);
        break;
      }
      case "checkout.session.async_payment_failed":
        db.alerts.push({ type: "checkout_payment_failed", session: obj.id, at: event.created });
        break;

      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await syncSubscription(obj, db);
        break;

      case "invoice.paid":
      case "invoice.payment_failed": {
        const subId = obj.parent?.subscription_details?.subscription;
        if (subId) {
          const rec = await syncSubscription(subId, db);
          if (event.type === "invoice.payment_failed") rec.lastPaymentFailedAt = event.created;
        } else if (db.schools[obj.customer]) {
          // School licence invoice
          const inv = db.schools[obj.customer].invoices?.[obj.id];
          if (inv) inv.status = event.type === "invoice.paid" ? "paid" : "payment_failed";
        }
        break;
      }

      case "charge.refunded":
      case "charge.dispute.created":
      case "radar.early_fraud_warning.created": {
        const pi = obj.payment_intent;
        const piId = typeof pi === "string" ? pi : pi?.id;
        const subId = await subscriptionForPaymentIntent(piId).catch(() => null);
        db.alerts.push({ type: event.type, object: obj.id, subscription: subId, at: event.created });
        console.warn(`⚠ ${event.type} for ${subId || piId || obj.id}. Review it in the Stripe Dashboard.`);
        break;
      }
    }
    db.processedEvents.push(event.id);
    await store.save(db);
    res.json({ received: true });
  } catch (err) {
    console.error(`Webhook ${event.type} failed:`, err.message);
    res.status(500).send("Handler error"); // Stripe will retry
  }
}

/* ---------------- App API ---------------- */
app.use(express.json());
app.use(express.static("public"));

app.get("/api/config", (_req, res) => res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY }));

// Is this user a paying Student?
app.get("/api/me", async (req, res) => {
  const db = (await store.load());
  const user = db.users[req.query.userId];
  const sub = user?.customerId ? db.customers[user.customerId] : null;
  res.json({
    plan: sub && ACCESS_STATUSES.includes(sub.status) ? "student" : "free",
    status: sub?.status ?? null,
    renewsAt: sub?.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
    paymentProblem: sub?.status === "past_due",
  });
});

const validUserId = id => typeof id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(id);
const hasAccess = (db, userId) => { const c = db.users[userId]?.customerId; return !!c && ACCESS_STATUSES.includes(db.customers[c]?.status); };

// Creates the Checkout Session for the $5/month Student plan
async function startCheckout(userId, { email, currency } = {}) {
  const db = (await store.load());
  const customerId = db.users[userId]?.customerId;
  const price = await priceFor(STUDENT_PRICE_KEY);
  return stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: price.id, quantity: 1 }],
    client_reference_id: userId,
    ...(customerId ? { customer: customerId } : email ? { customer_email: email } : {}),
    ...(currency === "dkk" ? { currency: "dkk" } : {}),
    allow_promotion_codes: true,
    integration_identifier: CHECKOUT_LABEL,
    success_url: `${PUBLIC_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${PUBLIC_URL}/canceled.html`,
  });
}

/* Link routes: the Study Lantern page can only open links, not call this API, so these redirect */
app.get("/subscribe", async (req, res) => {
  const uid = String(req.query.uid || "");
  if (!validUserId(uid)) return res.status(400).send("Ugyldigt link. Gå tilbage til Study Lantern og prøv igen.");
  try {
    if (hasAccess((await store.load()), uid)) return res.redirect(303, `/success.html?uid=${encodeURIComponent(uid)}`);
    const session = await startCheckout(uid, { currency: req.query.cur === "dkk" ? "dkk" : "usd" });
    res.redirect(303, session.url);
  } catch (err) {
    console.error("subscribe:", err.message);
    res.status(500).send("Betalingen kunne ikke startes lige nu. Prøv igen om lidt.");
  }
});
app.get("/account", async (req, res) => {
  const uid = String(req.query.uid || "");
  const customerId = validUserId(uid) && (await store.load()).users[uid]?.customerId;
  if (!customerId) return res.redirect(303, "/success.html?none=1");
  try {
    const portal = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: `${PUBLIC_URL}/success.html?uid=${encodeURIComponent(uid)}` });
    res.redirect(303, portal.url);
  } catch (err) {
    console.error("account:", err.message);
    res.status(500).send("Abonnementssiden kunne ikke åbnes. Prøv igen om lidt.");
  }
});

// Activation code for Study Lantern, after checkout (session_id) or later on (uid)
app.get("/api/activation", async (req, res) => {
  try {
    let uid = String(req.query.uid || "");
    if (req.query.session_id) {
      const s = await stripe.checkout.sessions.retrieve(String(req.query.session_id));
      if (s.status !== "complete" || s.payment_status === "unpaid" || !s.subscription || !validUserId(s.client_reference_id)) {
        return res.json({ ready: false, reason: s.status === "complete" ? "processing" : "not_paid" });
      }
      uid = s.client_reference_id;
      // Don't wait for the webhook: record the subscription now (the webhook will confirm the same state)
      await store.withLock(async () => {
        const db = (await store.load());
        db.users[uid] = { ...(db.users[uid] || {}), customerId: s.customer, email: s.customer_details?.email ?? null };
        (db.customers[s.customer] ||= {}).userId = uid;
        await syncSubscription(s.subscription, db);
        await store.save(db);
      });
    }
    if (!validUserId(uid)) return res.status(400).json({ error: "Missing user" });
    const db = (await store.load());
    const sub = db.customers[db.users[uid]?.customerId];
    if (!sub || !ACCESS_STATUSES.includes(sub.status) || !sub.currentPeriodEnd) return res.json({ ready: false, reason: "no_subscription" });
    res.json({ ready: true, code: makeCode(uid, sub.currentPeriodEnd), until: sub.currentPeriodEnd, cancelAtPeriodEnd: sub.cancelAtPeriodEnd });
  } catch (err) {
    console.error("activation:", err.message);
    res.status(500).json({ error: "Couldn't create the activation code." });
  }
});

// Start the $5/month Student subscription (JSON version, for the test page)
app.post("/api/checkout", async (req, res) => {
  try {
    const { userId, email, currency } = req.body || {};
    if (!userId) return res.status(400).json({ error: "userId is required" });
    if (hasAccess((await store.load()), userId)) {
      return res.status(409).json({ error: "You already have Student. Manage it from your account." });
    }
    const session = await startCheckout(userId, { email, currency });
    res.json({ url: session.url });
  } catch (err) {
    console.error("checkout:", err.message);
    res.status(500).json({ error: "Couldn't start checkout. Try again." });
  }
});
// What the success page shows (access itself is granted by the webhook)
app.get("/api/checkout-status", async (req, res) => {
  try {
    const s = await stripe.checkout.sessions.retrieve(String(req.query.session_id));
    res.json({ status: s.status, paymentStatus: s.payment_status, email: s.customer_details?.email ?? null });
  } catch {
    res.status(404).json({ error: "Checkout session not found" });
  }
});

// Customer Portal: cancel, change card, see invoices
app.post("/api/portal", async (req, res) => {
  try {
    const db = (await store.load());
    const customerId = db.users[req.body?.userId]?.customerId;
    if (!customerId) return res.status(404).json({ error: "No subscription found for this user." });
    const portal = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: `${PUBLIC_URL}/` });
    res.json({ url: portal.url });
  } catch (err) {
    console.error("portal:", err.message);
    res.status(500).json({ error: "Couldn't open the subscription page. Try again." });
  }
});

// Invoicing: a school buys seats and pays by invoice (due in 30 days)
app.post("/api/school-invoice", async (req, res) => {
  try {
    const { school, email, seats, currency } = req.body || {};
    const n = Number.parseInt(seats, 10);
    if (!school || !email || !(n >= 1 && n <= 5000)) return res.status(400).json({ error: "School name, email and 1–5000 seats are required." });
    const cur = currency === "dkk" ? "dkk" : "usd";
    const price = await priceFor(SCHOOL_PRICE_KEY);
    const customer = await stripe.customers.create({ name: school, email });
    const invoice = await stripe.invoices.create({
      customer: customer.id,
      collection_method: "send_invoice",
      days_until_due: 30,
      currency: cur,
      description: `Study Lantern licence for ${n} students, one school year.`,
    });
    await stripe.invoiceItems.create({ customer: customer.id, invoice: invoice.id, pricing: { price: price.id }, quantity: n });
    await stripe.invoices.finalizeInvoice(invoice.id);
    const sent = await stripe.invoices.sendInvoice(invoice.id);

    await store.withLock(async () => {
      const db = (await store.load());
      db.schools[customer.id] = { name: school, email, invoices: { ...(db.schools[customer.id]?.invoices || {}), [sent.id]: { seats: n, status: "sent" } } };
      await store.save(db);
    });
    res.json({ invoiceId: sent.id, total: sent.total, currency: sent.currency, hostedInvoiceUrl: sent.hosted_invoice_url, pdf: sent.invoice_pdf });
  } catch (err) {
    console.error("school-invoice:", err.message);
    res.status(500).json({ error: "Couldn't create the invoice. Try again." });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

const port = Number(process.env.PORT || 4242);
const storage = await store.init();
app.listen(port, () => {
  console.log(`Study Lantern payments running on ${PUBLIC_URL} (storage: ${storage})`);
  if (!process.env.STRIPE_WEBHOOK_SECRET) console.warn("⚠ STRIPE_WEBHOOK_SECRET is empty: webhooks will be rejected. Run `stripe listen` and paste the whsec_ value into .env.");
});
