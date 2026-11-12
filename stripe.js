import "dotenv/config";
import Stripe from "stripe";

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("STRIPE_SECRET_KEY is missing. Copy .env.example to .env and add your test key.");
}
if (/^[sr]k_live_/.test(process.env.STRIPE_SECRET_KEY) && process.env.NODE_ENV !== "production") {
  throw new Error("A live Stripe key is set outside production. Use a test key while developing.");
}

// One client instance, pinned to the SDK's API version.
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Lookup keys let the code find prices without hard-coding price IDs.
export const STUDENT_PRICE_KEY = "study_lantern_student_monthly";
export const SCHOOL_PRICE_KEY = "study_lantern_school_seat_yearly";
