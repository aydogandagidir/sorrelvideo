import { getStripeSync } from "./stripeClient";

export class WebhookHandlers {
  static async processWebhook(
    payload: Buffer,
    signature: string,
  ): Promise<void> {
    if (!Buffer.isBuffer(payload)) {
      throw new Error(
        `Webhook payload must be a raw Buffer (got ${typeof payload}). ` +
          "Ensure the webhook route is registered before express.json().",
      );
    }

    const sync = await getStripeSync();
    await sync.processWebhook(payload, signature);
  }
}
