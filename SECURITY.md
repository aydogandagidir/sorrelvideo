# Security Policy

We take the security of Sorrel and its users seriously. Thank you for helping keep it safe.

## Reporting a vulnerability

**Please do _not_ open a public GitHub issue for security problems.**

Report privately through one of:

- GitHub's **[Report a vulnerability](https://github.com/aydogandagidir/sorrelvideo/security/advisories/new)**
  (Security → Advisories → Report a vulnerability), or
- email **security@sorrel.video** _(replace with your real security contact)_.

Please include:

- a description of the issue and its impact,
- step‑by‑step reproduction (and a proof‑of‑concept if possible),
- affected endpoints/components and any relevant logs.

We aim to **acknowledge within 3 business days** and to keep you updated through resolution.
Please give us a reasonable window to fix the issue before any public disclosure.

## Supported versions

Only the latest `main` is supported (the product is in private alpha).

## Handling & hardening notes

- Secrets live **only** in environment variables — never commit `.env` or credentials.
- Passwords are hashed with **Argon2id**; verification/reset tokens are stored as **HMAC‑SHA256** hashes.
- Sensitive fields (passwords, tokens, cookies) are scrubbed before logging and before Sentry capture.
- Auth endpoints are rate‑limited; the Stripe webhook verifies signatures against the raw request body.
- Every persisted row is tenant‑isolated by `userId`.
