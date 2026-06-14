import { Link } from "wouter";
import { ArrowLeft, Video } from "lucide-react";

const LAST_UPDATED = "June 14, 2026";

// Operator: set your registered legal entity name and address before public
// launch (e.g. "Acme, Inc., 123 Main St, Wilmington, DE, USA"). Shown as the
// GDPR data controller so no bracketed placeholder is ever rendered to users.
const DATA_CONTROLLER = "Sorrel, the operator of sorrel.video";

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
        <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">
          Privacy Policy
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Last updated: {LAST_UPDATED}
        </p>

        <div className="prose prose-sm dark:prose-invert mt-8 max-w-none prose-headings:font-bold prose-headings:tracking-tight prose-a:text-primary">
          <p>
            This Privacy Policy explains how Sorrel (&ldquo;Sorrel&rdquo;,
            &ldquo;we&rdquo;, &ldquo;us&rdquo;, or &ldquo;our&rdquo;) collects,
            uses, shares, and protects information when you use our video
            production platform (the &ldquo;Service&rdquo;). It also describes
            your rights over your personal data and how to exercise them. By
            using the Service, you acknowledge the practices described here.
          </p>
          <p>
            This policy works alongside our{" "}
            <Link
              href="/terms"
              className="text-primary underline-offset-4 hover:underline"
            >
              Terms of Service
            </Link>
            . Capitalized terms not defined here have the meaning given in the
            Terms.
          </p>

          <h2>1. Who we are (data controller)</h2>
          <p>
            For the purposes of the EU and UK General Data Protection Regulation
            (&ldquo;GDPR&rdquo;) and similar laws, Sorrel is the
            &ldquo;controller&rdquo; of the personal data described in this
            policy. The Service is currently in private alpha. You can reach us
            about any privacy matter at{" "}
            <a href="mailto:privacy@sorrel.video">privacy@sorrel.video</a>. Our
            full legal entity name and registered address are set out in{" "}
            <a href="#contact">Section 14 (Contact)</a> below.
          </p>

          <h2>2. Information we collect</h2>
          <p>We collect the following categories of information:</p>
          <ul>
            <li>
              <strong>Account information</strong> — your email address, a
              password that we store only as an Argon2id hash (we never store or
              have access to your plaintext password), and optionally your name.
            </li>
            <li>
              <strong>Content you create</strong> — projects, brand kits
              (including logos, colors, fonts, taglines, and brand
              descriptions), uploaded media assets, the videos we render for
              you, scripts you submit for narration, prompts you send to AI
              features, and any website URL you ask us to capture.
            </li>
            <li>
              <strong>Usage and quota data</strong> — counters we keep to
              enforce plan limits (for example, monthly render and AI-suggestion
              counts) and basic product analytics about how you interact with
              the Service.
            </li>
            <li>
              <strong>Payment metadata</strong> — your subscription status,
              plan, and a Stripe customer identifier. Card numbers and other
              payment instrument details are collected and processed directly by
              Stripe; Sorrel never receives or stores your full card number.
            </li>
            <li>
              <strong>Authentication identifiers</strong> — server-side session
              records (stored in our database) tied to a session cookie or
              bearer token, email-verification and password-reset tokens (stored
              only as keyed hashes), and, if you choose to sign in with GitHub
              or Google, the verified email address and an opaque provider
              account identifier returned by that provider.
            </li>
            <li>
              <strong>Technical and log data</strong> — IP address, browser and
              device information, request metadata, and error diagnostics that
              we generate to operate, debug, and secure the Service.
            </li>
            <li>
              <strong>Cookies and local storage</strong> — see{" "}
              <a href="#cookies">Section 5</a>.
            </li>
          </ul>
          <p>
            You are not required to provide brand, content, or website data, but
            some features will not work without it. Please do not upload special
            categories of personal data (such as health, biometric, or
            government-ID data) into your content — the Service is not designed
            for it.
          </p>

          <h2>3. How we use information</h2>
          <ul>
            <li>To provide, maintain, and improve the Service;</li>
            <li>
              To authenticate you, keep your account secure, and enforce plan
              quotas and rate limits;
            </li>
            <li>
              To render videos, including capturing a server-side screenshot of
              any website URL you submit and generating AI copy or brand
              profiles when you use those features;
            </li>
            <li>
              To process subscriptions, payments, and renewals via Stripe;
            </li>
            <li>
              To send transactional emails such as email verification, password
              resets, and account or billing notices;
            </li>
            <li>
              To monitor, debug, prevent abuse of, and protect the security and
              integrity of the Service;
            </li>
            <li>
              To comply with our legal obligations and to establish, exercise,
              or defend legal claims.
            </li>
          </ul>
          <p>
            We do not sell your personal information, and we do not use your
            content to train our own models. We do not use your data for
            third-party advertising.
          </p>

          <h2>4. Legal bases for processing (GDPR)</h2>
          <p>Where the GDPR applies, we rely on the following legal bases:</p>
          <ul>
            <li>
              <strong>Performance of a contract</strong> — to create and
              authenticate your account, render and store your videos, and
              deliver the features you request.
            </li>
            <li>
              <strong>Legitimate interests</strong> — to secure the Service,
              prevent abuse and fraud, debug errors, and improve our product, in
              each case balanced against your rights.
            </li>
            <li>
              <strong>Legal obligation</strong> — to keep records (for example,
              billing and tax records) and to respond to lawful requests.
            </li>
            <li>
              <strong>Consent</strong> — where we ask for it, such as for
              non-essential processing; you may withdraw consent at any time
              without affecting prior processing.
            </li>
          </ul>

          <h2 id="cookies">5. Cookies and similar technologies</h2>
          <p>
            We keep cookies and similar technologies to a minimum and use only
            those that are strictly necessary to run the Service, plus a local
            preference flag:
          </p>
          <ul>
            <li>
              <strong>Session cookie</strong> — an essential, HTTP cookie that
              keeps you signed in. Without it you cannot use your account. (You
              may alternatively authenticate with a bearer token, in which case
              no session cookie is set.)
            </li>
            <li>
              <strong>Cookie-consent preference</strong> — a flag stored in your
              browser&apos;s local storage so we remember that you dismissed the
              cookie banner and do not show it again. This stays on your device
              and is not transmitted to us.
            </li>
          </ul>
          <p>
            We do not use advertising, marketing, or cross-site tracking
            cookies. Our error-monitoring provider (see{" "}
            <a href="#subprocessors">Section 6</a>) may set or read identifiers
            needed to correlate diagnostic events. Because we set only strictly
            necessary cookies, our banner is informational; you can also block
            or delete cookies through your browser settings, though doing so may
            sign you out.
          </p>

          <h2 id="subprocessors">6. Sub-processors and third parties</h2>
          <p>
            We share personal data with a small set of trusted service providers
            (&ldquo;sub-processors&rdquo;) that process it on our behalf, only
            as needed to run the Service and under contractual confidentiality
            and data-protection obligations. They are not permitted to use your
            data for their own purposes.
          </p>
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Purpose</th>
                  <th>Data involved</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Stripe</td>
                  <td>Payment processing &amp; subscription management</td>
                  <td>
                    Payment details (handled by Stripe), billing email, customer
                    &amp; subscription identifiers
                  </td>
                </tr>
                <tr>
                  <td>Google Cloud (Cloud Storage)</td>
                  <td>Storage of uploaded assets and rendered videos</td>
                  <td>
                    Your uploaded media and generated files (private,
                    owner-restricted)
                  </td>
                </tr>
                <tr>
                  <td>Anthropic &amp; OpenAI</td>
                  <td>
                    AI copy suggestions, brand extraction, and narration
                    features
                  </td>
                  <td>
                    The prompt, brand context, script, or website text you
                    submit to an AI feature
                  </td>
                </tr>
                <tr>
                  <td>Resend</td>
                  <td>Delivery of transactional email</td>
                  <td>Your email address and the message contents</td>
                </tr>
                <tr>
                  <td>Sentry</td>
                  <td>
                    Application error tracking &amp; performance monitoring
                  </td>
                  <td>
                    Error diagnostics and request metadata (password and token
                    fields are scrubbed)
                  </td>
                </tr>
                <tr>
                  <td>Railway</td>
                  <td>Cloud hosting &amp; infrastructure</td>
                  <td>
                    Hosts the application and database; processes all of the
                    above in transit
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>
            We may add or change sub-processors as the Service evolves; we will
            update this list and, where required, notify you. We may also
            disclose information if required by law, to enforce our agreements,
            or to protect the rights, safety, and security of our users and the
            Service. If we are involved in a merger, acquisition, or sale of
            assets, personal data may be transferred subject to this policy.
          </p>

          <h2>7. AI features</h2>
          <p>
            When you use AI-assisted features (such as copy suggestions, brand
            extraction from a website, or script-to-narration), the prompt,
            brand context, screenshot, or text you provide is sent to our
            configured AI provider (Anthropic or OpenAI) to generate a result.
            We do not store AI provider API keys in your account, and we do not
            persist the provider&apos;s raw responses beyond what is needed to
            return the result to you and operate the feature. These providers
            process the input as our sub-processor; we do not authorize them to
            use your inputs to train their models.
          </p>

          <h2>8. Website capture</h2>
          <p>
            The Website-to-Video feature loads a URL that you supply and takes a
            server-side screenshot of the page so it can be turned into a video.
            Only submit URLs you are authorized to capture. We apply technical
            safeguards to block requests to internal, private, or unauthorized
            network addresses. The captured screenshot is stored as part of your
            project content and is subject to this policy.
          </p>

          <h2>9. Data retention</h2>
          <p>
            We retain your account and content for as long as your account is
            active or as needed to provide the Service. Specific retention
            practices include:
          </p>
          <ul>
            <li>
              <strong>Sessions</strong> expire after a fixed period (currently
              seven days), or sooner when you log out; resetting your password
              invalidates all existing sessions.
            </li>
            <li>
              <strong>Email-verification and password-reset tokens</strong> are
              short-lived (hours) and deleted once used or expired.
            </li>
            <li>
              <strong>Content and account data</strong> are deleted or
              anonymized within a reasonable period after you delete your
              account, except where we must retain certain records (for example,
              billing, tax, or fraud-prevention records) to meet legal
              obligations.
            </li>
            <li>
              <strong>Logs and diagnostics</strong> are kept only as long as
              needed for security, debugging, and operational purposes.
            </li>
          </ul>

          <h2>10. International data transfers</h2>
          <p>
            We and our sub-processors may process your information in countries
            other than where you live, including the United States. Where we
            transfer personal data out of the European Economic Area, the United
            Kingdom, or Switzerland, we rely on appropriate safeguards such as
            the European Commission&apos;s Standard Contractual Clauses (and the
            UK Addendum) or an adequacy decision, as applicable. You can contact
            us for more information about the safeguards in place.
          </p>

          <h2>11. Security</h2>
          <p>
            We use technical and organizational measures designed to protect
            your information, including encryption of data in transit
            (HTTPS/TLS), Argon2id password hashing, per-account data isolation
            and owner-level access controls on stored objects, scrubbing of
            secrets from error reports, and rate limiting on sensitive
            endpoints. No method of transmission or storage is completely
            secure, so while we work hard to protect your data, we cannot
            guarantee absolute security. We do not currently hold formal
            certifications such as SOC 2 or ISO 27001.
          </p>

          <h2>12. Your rights</h2>
          <p>
            Depending on where you live, you may have some or all of the
            following rights over your personal data:
          </p>
          <ul>
            <li>
              <strong>Access</strong> — obtain a copy of the personal data we
              hold about you;
            </li>
            <li>
              <strong>Rectification</strong> — correct inaccurate or incomplete
              data;
            </li>
            <li>
              <strong>Erasure</strong> — request deletion of your data (the
              &ldquo;right to be forgotten&rdquo;), subject to legal retention
              limits;
            </li>
            <li>
              <strong>Portability</strong> — receive your data in a structured,
              commonly used, machine-readable format;
            </li>
            <li>
              <strong>Restriction and objection</strong> — restrict or object to
              certain processing, including processing based on our legitimate
              interests;
            </li>
            <li>
              <strong>Withdraw consent</strong> — where processing is based on
              consent, withdraw it at any time.
            </li>
          </ul>
          <p>
            You can exercise many of these rights directly in the app (for
            example, by editing your profile and content or deleting your
            account). For anything else, email{" "}
            <a href="mailto:privacy@sorrel.video">privacy@sorrel.video</a> and
            we will respond consistent with applicable law (normally within one
            month). You also have the right to lodge a complaint with your local
            data protection authority, though we encourage you to contact us
            first.
          </p>

          <h2>13. Children&apos;s privacy</h2>
          <p>
            The Service is not directed to children. It is intended for users
            who are at least 16 years old (or the age of digital consent in your
            jurisdiction, whichever is higher). We do not knowingly collect
            personal data from children. If you believe a child has provided us
            personal data, contact us and we will delete it.
          </p>

          <h2>14. Data breach notification</h2>
          <p>
            We maintain procedures to detect, investigate, and respond to
            security incidents. If a personal data breach is likely to result in
            a risk to your rights and freedoms, we will notify the relevant
            supervisory authority and affected users without undue delay, as
            required by applicable law.
          </p>

          <h2>15. Changes to this policy</h2>
          <p>
            We may update this Privacy Policy from time to time. When we make
            material changes, we will communicate them through the Service or by
            email where appropriate, and we will update the &ldquo;Last
            updated&rdquo; date above. Your continued use of the Service after
            an update takes effect constitutes acknowledgment of the revised
            policy.
          </p>

          <h2 id="contact">16. Contact</h2>
          <p>
            For privacy questions, requests, or to exercise your data rights,
            contact us at{" "}
            <a href="mailto:privacy@sorrel.video">privacy@sorrel.video</a>.
          </p>
          <p>
            <strong>Data controller:</strong> {DATA_CONTROLLER}. If we appoint a
            Data Protection Officer or an EU/UK representative, their contact
            details will be published here.
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
