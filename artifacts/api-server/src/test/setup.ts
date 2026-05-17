// Sane defaults so modules that read env at import time do not throw during
// unit tests. CI overrides DATABASE_URL and other secrets via workflow env.
// pg.Pool itself is lazy — no socket is opened unless a query runs.
process.env.DATABASE_URL ??=
  "postgres://postgres:postgres@localhost:5432/sorrel_test";
process.env.SESSION_SECRET ??= "test-secret";
process.env.STRIPE_SECRET_KEY ??= "sk_test_dummy";
process.env.STRIPE_WEBHOOK_SECRET ??= "whsec_dummy";
process.env.PORT ??= "8080";
process.env.NODE_ENV ??= "test";
