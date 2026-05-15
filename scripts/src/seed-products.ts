import { getUncachableStripeClient } from "./stripeClient";

async function createProducts() {
  try {
    const stripe = await getUncachableStripeClient();

    console.log("Checking for existing Sorrel Pro Plan...");

    const existing = await stripe.products.search({
      query: "name:'Sorrel Pro' AND active:'true'",
    });

    if (existing.data.length > 0) {
      console.log("Sorrel Pro product already exists. Listing prices...");
      const prices = await stripe.prices.list({
        product: existing.data[0].id,
        active: true,
      });
      for (const p of prices.data) {
        console.log(
          `  Price: ${p.id}  $${((p.unit_amount ?? 0) / 100).toFixed(2)}/${p.recurring?.interval}`,
        );
      }
      return;
    }

    console.log("Creating Sorrel Pro product...");
    const product = await stripe.products.create({
      name: "Sorrel Pro",
      description:
        "Unlimited renders, all premium templates, priority support.",
      metadata: { plan: "pro" },
    });
    console.log(`Created product: ${product.name} (${product.id})`);

    const monthlyPrice = await stripe.prices.create({
      product: product.id,
      unit_amount: 2900,
      currency: "usd",
      recurring: { interval: "month" },
    });
    console.log(
      `Created monthly price: $29.00/month (${monthlyPrice.id})`,
    );

    console.log("\nAll done! Webhooks will sync this to the database.");
    console.log("Monthly price ID to use in checkout:", monthlyPrice.id);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Error creating products:", msg);
    process.exit(1);
  }
}

createProducts();
