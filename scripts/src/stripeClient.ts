import Stripe from "stripe";
import { StripeSync } from "stripe-replit-sync";

interface ConnectorSettings {
  publishable: string;
  secret: string;
}

interface ConnectorItem {
  settings: ConnectorSettings;
}

interface ConnectorResponse {
  items: ConnectorItem[];
}

async function getCredentials(): Promise<{
  publishableKey: string;
  secretKey: string;
}> {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? "depl " + process.env.WEB_REPL_RENEWAL
      : null;

  if (!hostname || !xReplitToken) {
    throw new Error(
      "Missing Replit environment variables. " +
        "Ensure the Stripe integration is connected via the Integrations tab.",
    );
  }

  const url = new URL(`https://${hostname}/api/v2/connection`);
  url.searchParams.set("include_secrets", "true");
  url.searchParams.set("connector_names", "stripe");
  url.searchParams.set("environment", "development");

  const response = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "X-Replit-Token": xReplitToken,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch Stripe credentials: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as ConnectorResponse;
  const settings = data.items[0]?.settings;

  if (!settings?.publishable || !settings?.secret) {
    throw new Error(
      "Stripe connection not found. Connect Stripe via the Integrations tab first.",
    );
  }

  return {
    publishableKey: settings.publishable,
    secretKey: settings.secret,
  };
}

export async function getUncachableStripeClient(): Promise<Stripe> {
  const { secretKey } = await getCredentials();
  return new Stripe(secretKey, {
    apiVersion: "2026-04-22.dahlia",
  });
}
