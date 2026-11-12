// Registers the hosted server's /webhook address with Stripe and prints its signing secret.
// Usage: PUBLIC_URL=https://your-server.example node scripts/create-webhook.js
import { stripe } from "../stripe.js";

const base = process.env.PUBLIC_URL;
if (!base || !base.startsWith("https://")) {
  console.error("Set PUBLIC_URL to the server's https:// address first.");
  process.exit(1);
}
const url = `${base.replace(/\/$/, "")}/webhook`;
const events = [
  "checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed",
  "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted",
  "invoice.paid", "invoice.payment_failed",
  "charge.refunded", "charge.dispute.created", "radar.early_fraud_warning.created",
];

const existing = (await stripe.webhookEndpoints.list({ limit: 100 })).data.find(e => e.url === url);
if (existing) {
  await stripe.webhookEndpoints.update(existing.id, { enabled_events: events });
  console.log(`✓ Webhook for ${url} already exists; events updated. Its secret is shown in the Stripe Dashboard.`);
} else {
  const ep = await stripe.webhookEndpoints.create({ url, enabled_events: events, description: "Study Lantern payments server" });
  console.log(`+ Webhook created for ${url}`);
  console.log(`Set this on the host as STRIPE_WEBHOOK_SECRET (keep it secret):\n${ep.secret}`);
}
