import { Link } from "wouter";
import { ArrowLeft, Video } from "lucide-react";

const LAST_UPDATED = "June 3, 2026";

export default function Privacy() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b bg-background">
        <div className="container mx-auto flex h-16 items-center justify-between px-4">
          <Link
            href="/"
            className="flex items-center gap-2 font-bold text-lg tracking-tight"
          >
            <Video className="h-5 w-5 text-primary" />
            <span>Sorrel</span>
          </Link>
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-4 w-4" /> Back to home
          </Link>
        </div>
      </header>

      <main className="container mx-auto max-w-3xl px-4 py-12">
        <div
          className="mb-8 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300"
          role="note"
        >
          <strong className="font-semibold">
            DRAFT — review with legal counsel before public launch.
          </strong>{" "}
          This document is a placeholder template and does not yet constitute a
          binding privacy policy.
        </div>

        <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">
          Privacy Policy
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Last updated: {LAST_UPDATED}
        </p>

        <div className="prose prose-sm dark:prose-invert mt-8 max-w-none prose-headings:font-bold prose-headings:tracking-tight prose-a:text-primary">
          <p>
            This Privacy Policy explains how Sorrel (&ldquo;we&rdquo;,
            &ldquo;us&rdquo;, or &ldquo;our&rdquo;) collects, uses, and shares
            information when you use our video production platform (the
            &ldquo;Service&rdquo;). By using the Service, you agree to the
            practices described here.
          </p>

          <h2>1. Information we collect</h2>
          <ul>
            <li>
              <strong>Account information</strong> — your email address, an
              Argon2id-hashed password (we never store plaintext passwords), and
              optionally your first and last name.
            </li>
            <li>
              <strong>Content you create</strong> — projects, brand kit settings,
              uploaded assets, prompts you submit to AI features, and any website
              URL you ask us to capture.
            </li>
            <li>
              <strong>Billing information</strong> — subscription and payment
              status. Card details are handled directly by Stripe; we do not
              store full card numbers.
            </li>
            <li>
              <strong>Technical and usage data</strong> — log data, IP address,
              browser/device information, and error diagnostics needed to operate
              and secure the Service.
            </li>
          </ul>

          <h2>2. Cookies and similar technologies</h2>
          <p>
            We use a small number of cookies and similar technologies that are
            strictly necessary to provide the Service:
          </p>
          <ul>
            <li>
              <strong>Authentication cookies</strong> — a session cookie keeps
              you signed in. It is essential; without it you cannot use your
              account.
            </li>
            <li>
              <strong>Local storage</strong> — we store a flag in your browser to
              remember that you dismissed the cookie banner, so we do not show it
              again.
            </li>
          </ul>
          <p>
            We do not use advertising or cross-site tracking cookies. Error
            monitoring (see below) may set or read identifiers needed to
            correlate diagnostic events.
          </p>

          <h2>3. How we use information</h2>
          <ul>
            <li>To provide, maintain, and improve the Service;</li>
            <li>To authenticate you and keep your account secure;</li>
            <li>To process subscriptions and billing;</li>
            <li>
              To send transactional emails (for example, email verification and
              password resets);
            </li>
            <li>
              To render videos, including capturing a screenshot of any website
              URL you submit to the Service;
            </li>
            <li>
              To monitor, debug, and protect the Service against abuse and
              security threats;
            </li>
            <li>To comply with legal obligations.</li>
          </ul>

          <h2>4. Third parties we share data with</h2>
          <p>
            We share information with service providers
            (&ldquo;processors&rdquo;) only as needed to run the Service:
          </p>
          <ul>
            <li>
              <strong>Stripe</strong> — payment processing and subscription
              management.
            </li>
            <li>
              <strong>Resend</strong> — delivery of transactional emails.
            </li>
            <li>
              <strong>Google Cloud Storage</strong> — storage of uploaded assets
              and generated files.
            </li>
            <li>
              <strong>Sentry</strong> — application error tracking and
              performance monitoring. We configure Sentry to scrub password and
              token fields from captured data.
            </li>
          </ul>
          <p>
            We do not sell your personal information. We may disclose information
            if required by law or to protect the rights, safety, and security of
            our users and the Service.
          </p>

          <h2>5. AI features</h2>
          <p>
            When you use AI-assisted features, the prompt and brand-voice context
            you provide are sent to our configured AI provider (such as Anthropic
            or OpenAI) to generate suggestions. We do not store your AI provider
            API keys in your account, and we do not persist the provider&apos;s
            raw responses beyond what is needed to return the result to you.
          </p>

          <h2>6. Data retention</h2>
          <p>
            We retain your account and content for as long as your account is
            active. Sessions expire after a fixed period (currently seven days).
            Email verification and password-reset tokens are short-lived and
            deleted once used or expired. When you delete your account, we delete
            or anonymize associated personal data within a reasonable period,
            except where we must retain certain records (for example, billing
            records) to comply with legal obligations.
          </p>

          <h2>7. Security</h2>
          <p>
            We use technical and organizational measures to protect your
            information, including hashed passwords, scoped data access per
            account, and encrypted transport. No method of transmission or
            storage is completely secure, and we cannot guarantee absolute
            security.
          </p>

          <h2>8. Your rights</h2>
          <p>
            Depending on your jurisdiction, you may have rights to access,
            correct, export, or delete your personal data, and to object to or
            restrict certain processing. To exercise these rights, contact us
            using the details below. We will respond consistent with applicable
            law.
          </p>

          <h2>9. International users</h2>
          <p>
            Your information may be processed in countries other than where you
            live. Where required, we rely on appropriate safeguards for such
            transfers.
          </p>

          <h2>10. Changes to this policy</h2>
          <p>
            We may update this Privacy Policy from time to time. Material changes
            will be communicated through the Service or by email where
            appropriate. The &ldquo;Last updated&rdquo; date above reflects the
            latest revision.
          </p>

          <h2>11. Contact</h2>
          <p>
            Questions or requests regarding this policy? Contact us at{" "}
            <a href="mailto:privacy@sorrel.video">privacy@sorrel.video</a>.
          </p>
        </div>

        <div className="mt-12 border-t pt-6 text-sm text-muted-foreground">
          See also our{" "}
          <Link
            href="/terms"
            className="text-primary underline-offset-4 hover:underline"
          >
            Terms of Service
          </Link>
          .
        </div>
      </main>
    </div>
  );
}
