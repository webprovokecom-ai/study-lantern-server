# Study Lantern · payments server

Handles the money side of Study Lantern with Stripe:

| What | How |
| --- | --- |
| **Student plan, $5/month** (35 kr. for Danish customers) | Stripe Checkout in subscription mode |
| **Cancel, change card, see receipts** | Stripe Customer Portal |
| **Schools buying licences** | Stripe Invoicing: an invoice is emailed and due in 30 days |
| **Who has paid** | Webhooks keep the server's copy of each subscription up to date |

Your Stripe account has **Managed Payments** on, so Stripe sells on your behalf and handles VAT and sales tax. Each product therefore carries a tax code from Stripe's [tax code list](https://docs.stripe.com/tax/tax-codes):
`txcd_10103000` (SaaS, personal use) for Student and `txcd_10103001` (SaaS, business use) for school licences.

Student prices **include VAT** (exactly 35 kr. / $5). School licence prices are shown **before VAT**, as businesses expect.

## How the Study Lantern page connects

The Study Lantern page can't call this server directly (it runs inside claude.ai), so it uses links and a signed code:

1. **Start Student** opens `/subscribe?uid=…` in a new tab, which redirects to Stripe Checkout.
2. After paying, `/success.html` shows an **activation code**: a note signed with `ACTIVATION_PRIVATE_KEY` saying "this student has Student until date X".
3. The student pastes it into Study Lantern, which checks the signature with the public key built into the page. Made-up or edited codes are rejected.
4. **Manage subscription** opens `/account?uid=…`, which redirects to the Customer Portal.

Set `PAY_URL` in the Study Lantern page to wherever this server is hosted. If you replace the signing key (`npm run keys` on a fresh `.env`), also update `ACT_KEY` in the page.

When Study Lantern gets real logins, replace the code step: the page asks this server directly whether the logged-in student has Student.

## Run it locally

You need Node.js 20+ and the Stripe CLI (`npm install -g @stripe/cli`).

1. `npm install`
2. Copy `.env.example` to `.env` and add your **test** keys.
3. `npm run setup` creates the products, prices and Customer Portal settings in Stripe (safe to run again).
4. `npm run keys` creates the activation-code signing key (once) and prints the public key for the page.
5. In one terminal: `npm run webhooks`. It prints a `whsec_…` signing secret: put it in `.env` as `STRIPE_WEBHOOK_SECRET`.
6. In another terminal: `npm start`, then open <http://localhost:4242>.

Pay with the test card `4242 4242 4242 4242`, any future date and any CVC.

## API

| Route | Does |
| --- | --- |
| `POST /api/checkout` `{userId, email?, currency?}` | Returns a Stripe Checkout link for the Student plan |
| `GET /api/me?userId=` | `{plan: "student" | "free", status, renewsAt, cancelAtPeriodEnd, paymentProblem}` |
| `POST /api/portal` `{userId}` | Returns a Customer Portal link |
| `POST /api/school-invoice` `{school, email, seats, currency}` | Creates and emails a licence invoice |
| `GET /subscribe?uid=&cur=` | Link: starts Checkout (used by the Study Lantern page) |
| `GET /account?uid=` | Link: opens the Customer Portal |
| `GET /api/activation?session_id= or ?uid=` | Returns the signed activation code |
| `POST /webhook` | Receives Stripe events (signature checked) |

Webhook events handled: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `customer.subscription.created/updated/deleted`, `invoice.paid`, `invoice.payment_failed`, `charge.refunded`, `charge.dispute.created`, `radar.early_fraud_warning.created`.

## Before going live

- [ ] The Stripe account must belong to an adult (18+) or a company. Finish account activation in the Dashboard.
- [ ] Replace `data/db.json` with a real database, and `userId` with the logged-in student's account id.
- [ ] Host the server (e.g. Render, Railway, Fly.io) and set `PUBLIC_URL` to its address.
- [ ] Keep keys in the host's secret settings, never in code. Use a **restricted key** (`rk_live_…`) with only the permissions this server needs instead of the full secret key.
- [ ] Add a webhook endpoint in the Dashboard pointing at `https://your-domain/webhook`, subscribed to the events listed above, and use its signing secret.
- [ ] Turn on 2-factor login (passkey or authenticator app) for the Stripe Dashboard.
- [ ] Walk through Stripe's [go-live checklist](https://docs.stripe.com/get-started/checklist/go-live).
