// Creates the Study Lantern catalog and Customer Portal settings in your Stripe account.
// Safe to run more than once: it reuses what already exists (found by lookup key).
import { stripe, STUDENT_PRICE_KEY, SCHOOL_PRICE_KEY } from "../stripe.js";

async function ensurePrice({ lookupKey, product, price }) {
  const found = await stripe.prices.list({ lookup_keys: [lookupKey], expand: ["data.product"] });
  if (found.data.length) {
    const prod = found.data[0].product;
    if (prod.tax_code?.id !== product.tax_code && prod.tax_code !== product.tax_code) {
      await stripe.products.update(prod.id, { tax_code: product.tax_code });
      console.log(`✓ ${product.name}: tax code set to ${product.tax_code}`);
    }
    if (price.tax_behavior && found.data[0].tax_behavior === "unspecified") {
      await stripe.prices.update(found.data[0].id, { tax_behavior: price.tax_behavior });
      console.log(`✓ ${product.name}: prices now ${price.tax_behavior === "inclusive" ? "include" : "exclude"} tax`);
    }
    console.log(`✓ ${lookupKey} already exists (${found.data[0].id})`);
    return found.data[0];
  }
  const prod = await stripe.products.create(product);
  const created = await stripe.prices.create({ ...price, product: prod.id, lookup_key: lookupKey });
  console.log(`+ created ${product.name}: ${created.id}`);
  return created;
}

// Student plan: $5/month, with a Danish-kroner price for Danish customers (ca. 35 kr.)
const student = await ensurePrice({
  lookupKey: STUDENT_PRICE_KEY,
  product: {
    name: "Study Lantern Student",
    description: "Unlimited AI explanations, videos, quizzes, huskespørgsmål and exam practice.",
    tax_code: "txcd_10103000", // Software as a service (SaaS) - personal use
  },
  price: {
    currency: "usd",
    unit_amount: 500,
    recurring: { interval: "month" },
    tax_behavior: "inclusive", // students pay exactly 35 kr. / $5; VAT is inside the price
    currency_options: { dkk: { unit_amount: 3500, tax_behavior: "inclusive" } },
  },
});

// School licence, sold by invoice: per student seat per year
const school = await ensurePrice({
  lookupKey: SCHOOL_PRICE_KEY,
  product: {
    name: "Study Lantern School licence",
    description: "One student seat for a school year, billed to the school by invoice.",
    tax_code: "txcd_10103001", // Software as a service (SaaS) - business use
  },
  // Schools are businesses, so the licence price is shown before VAT
  price: { currency: "usd", unit_amount: 3000, tax_behavior: "exclusive", currency_options: { dkk: { unit_amount: 20000, tax_behavior: "exclusive" } } },
});

// Customer Portal: let students cancel, update their card and download invoices
const portalConfigs = await stripe.billingPortal.configurations.list({ is_default: true, limit: 1 });
const features = {
  customer_update: { enabled: true, allowed_updates: ["email", "address"] },
  invoice_history: { enabled: true },
  payment_method_update: { enabled: true },
  subscription_cancel: { enabled: true, mode: "at_period_end" },
};
if (portalConfigs.data.length) {
  await stripe.billingPortal.configurations.update(portalConfigs.data[0].id, { features });
  console.log("✓ Customer Portal settings updated");
} else {
  await stripe.billingPortal.configurations.create({
    business_profile: { headline: "Manage your Study Lantern subscription" },
    features,
  });
  console.log("+ Customer Portal configured");
}

console.log(`\nStudent price: ${student.id}\nSchool price:  ${school.id}`);
