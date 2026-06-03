import { Link } from "wouter";
import { ArrowLeft, Video } from "lucide-react";

const LAST_UPDATED = "June 3, 2026";

export default function Terms() {
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
          This document is a placeholder template and does not yet constitute
          binding legal terms.
        </div>

        <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">
          Terms of Service
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Last updated: {LAST_UPDATED}
        </p>

        <div className="prose prose-sm dark:prose-invert mt-8 max-w-none prose-headings:font-bold prose-headings:tracking-tight prose-a:text-primary">
          <p>
            These Terms of Service (&ldquo;Terms&rdquo;) govern your access to
            and use of Sorrel (the &ldquo;Service&rdquo;), a video production
            platform operated by Sorrel (&ldquo;we&rdquo;, &ldquo;us&rdquo;, or
            &ldquo;our&rdquo;). By creating an account or using the Service, you
            agree to be bound by these Terms. If you do not agree, do not use the
            Service.
          </p>

          <h2>1. The Service</h2>
          <p>
            Sorrel lets you compose branded short-form video by selecting HTML
            templates, which we render server-side and return to you as video
            files. The Service is currently in private alpha; features may
            change, break, or be removed, and availability is not guaranteed.
          </p>

          <h2>2. Accounts</h2>
          <p>
            You must provide accurate information when registering and keep your
            credentials secure. You are responsible for all activity under your
            account. You must be at least the age of majority in your
            jurisdiction to use the Service. Notify us promptly of any
            unauthorized use of your account.
          </p>

          <h2>3. Acceptable use</h2>
          <p>You agree not to use the Service to:</p>
          <ul>
            <li>
              Violate any law, regulation, or third-party right (including
              intellectual property, privacy, and publicity rights);
            </li>
            <li>
              Upload or generate content that is unlawful, infringing,
              defamatory, hateful, or that depicts or exploits minors;
            </li>
            <li>
              Submit URLs or content that point to internal, private, or
              unauthorized systems, or attempt to use the Service to access
              resources you are not entitled to;
            </li>
            <li>
              Reverse engineer, scrape, overload, or disrupt the Service, or
              circumvent any usage limits, rate limits, or access controls;
            </li>
            <li>Resell or sublicense the Service without our written consent.</li>
          </ul>
          <p>
            We may suspend or terminate accounts that violate these Terms.
          </p>

          <h2>4. Billing, plans, and refunds</h2>
          <p>
            Paid subscriptions are billed through our payment processor, Stripe,
            on a recurring basis until cancelled. By subscribing you authorize
            recurring charges to your payment method. You can cancel at any time;
            cancellation stops future renewals but does not, by default,
            retroactively refund the current billing period.
          </p>
          <p>
            Free plans are subject to usage limits (for example, a monthly render
            quota). Except where required by applicable law, fees are
            non-refundable. If you believe you were charged in error, contact us
            and we will review the request in good faith.
          </p>

          <h2>5. Your content and intellectual property</h2>
          <p>
            You retain ownership of the text, images, brand assets, and other
            materials you upload or generate (&ldquo;User Content&rdquo;). You
            grant us a
            limited, worldwide, non-exclusive license to host, process, render,
            and store your User Content solely to operate and provide the
            Service.
          </p>
          <p>
            You represent that you have all rights necessary to your User
            Content and to any third-party website you ask us to capture. The
            Service, including its software, templates we author, and branding,
            remains our property or that of our licensors.
          </p>

          <h2>6. Third-party services</h2>
          <p>
            The Service relies on third-party providers — including Stripe
            (payments), Resend (transactional email), Google Cloud Storage (file
            storage), and Sentry (error monitoring). Your use of the Service may
            be subject to those providers&apos; terms, and we are not responsible
            for their acts or omissions.
          </p>

          <h2>7. Disclaimers</h2>
          <p>
            The Service is provided &ldquo;as is&rdquo; and &ldquo;as
            available&rdquo; without warranties of any kind, whether express or
            implied, including
            warranties of merchantability, fitness for a particular purpose, and
            non-infringement. We do not warrant that the Service will be
            uninterrupted, secure, or error-free.
          </p>

          <h2>8. Limitation of liability</h2>
          <p>
            To the maximum extent permitted by law, we will not be liable for any
            indirect, incidental, special, consequential, or punitive damages, or
            for any loss of profits or data, arising out of or related to your
            use of the Service. Our total liability for any claim will not exceed
            the amount you paid us in the twelve months preceding the claim.
          </p>

          <h2>9. Termination</h2>
          <p>
            You may stop using the Service at any time. We may suspend or
            terminate your access if you breach these Terms or if we discontinue
            the Service. Upon termination, your right to use the Service ceases,
            and we may delete your account and associated data subject to our
            retention practices.
          </p>

          <h2>10. Changes to these Terms</h2>
          <p>
            We may update these Terms from time to time. If we make material
            changes, we will take reasonable steps to notify you. Your continued
            use of the Service after changes take effect constitutes acceptance
            of the revised Terms.
          </p>

          <h2>11. Contact</h2>
          <p>
            Questions about these Terms? Contact us at{" "}
            <a href="mailto:support@sorrel.video">support@sorrel.video</a>.
          </p>
        </div>

        <div className="mt-12 border-t pt-6 text-sm text-muted-foreground">
          See also our{" "}
          <Link
            href="/privacy"
            className="text-primary underline-offset-4 hover:underline"
          >
            Privacy Policy
          </Link>
          .
        </div>
      </main>
    </div>
  );
}
