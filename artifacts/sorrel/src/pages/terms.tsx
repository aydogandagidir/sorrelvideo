import { Link } from "wouter";
import { ArrowLeft, Video } from "lucide-react";

const LAST_UPDATED = "June 14, 2026";

// Operator: set your governing-law jurisdiction before public launch
// (e.g. "the State of Delaware, USA" or "England and Wales"). Used in the
// Governing Law section so no bracketed placeholder is ever shown to users.
const GOVERNING_LAW =
  "the jurisdiction in which Sorrel's operating entity is established";

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
        <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">
          Terms of Service
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Last updated: {LAST_UPDATED}
        </p>

        <div className="prose prose-sm dark:prose-invert mt-8 max-w-none prose-headings:font-bold prose-headings:tracking-tight prose-a:text-primary">
          <p>
            These Terms of Service (&ldquo;Terms&rdquo;) form a binding
            agreement between you (&ldquo;you&rdquo; or &ldquo;your&rdquo;) and
            Sorrel (&ldquo;Sorrel&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;, or
            &ldquo;our&rdquo;) and govern your access to and use of the Sorrel
            video production platform, websites, and related services
            (collectively, the &ldquo;Service&rdquo;). By creating an account,
            clicking to accept, or otherwise accessing or using the Service, you
            agree to be bound by these Terms and by our{" "}
            <Link href="/privacy">Privacy Policy</Link>, which is incorporated
            here by reference. If you do not agree, do not access or use the
            Service. If you use the Service on behalf of an organization, you
            represent that you have authority to bind that organization, and
            &ldquo;you&rdquo; refers to that organization.
          </p>

          <h2>1. Acceptance of these Terms</h2>
          <p>
            Your access to and use of the Service is conditioned on your
            acceptance of and compliance with these Terms. These Terms apply to
            all visitors, users, and others who access the Service. We may
            require you to accept updated Terms before continuing to use the
            Service; if you do not accept them, you must stop using the Service.
          </p>

          <h2>2. Eligibility and age</h2>
          <p>
            You must be at least 18 years old, or the age of majority in your
            jurisdiction if higher, to create an account or use the Service. The
            Service is not directed to children, and we do not knowingly allow
            anyone under the required age to use it. By using the Service, you
            represent and warrant that you meet these requirements and that you
            are not barred from using the Service under any applicable law.
          </p>

          <h2>3. Accounts and security</h2>
          <p>
            To use most features you must create an account and provide
            accurate, current, and complete information. You are responsible for
            safeguarding your account credentials and for all activity that
            occurs under your account, whether or not authorized by you. You
            agree to:
          </p>
          <ul>
            <li>keep your password and any access tokens confidential;</li>
            <li>
              notify us promptly at{" "}
              <a href="mailto:support@sorrel.video">support@sorrel.video</a> of
              any unauthorized use of, or security breach affecting, your
              account;
            </li>
            <li>
              not share, sell, or transfer your account or impersonate any
              person or entity.
            </li>
          </ul>
          <p>
            We are not liable for any loss arising from unauthorized use of your
            account that results from your failure to maintain its security.
          </p>

          <h2>4. Description of the Service</h2>
          <p>
            Sorrel is a modular platform for creating branded short-form video.
            Depending on your plan and the features then available, the Service
            may let you:
          </p>
          <ul>
            <li>
              <strong>Compose video from templates (Studio).</strong> Select and
              configure HTML-based templates with your own copy, brand colors,
              fonts, and assets.
            </li>
            <li>
              <strong>Generate copy with AI.</strong> Request AI-assisted
              suggestions for headlines, body text, calls to action, brand
              details, and video concepts.
            </li>
            <li>
              <strong>Website&nbsp;&rarr;&nbsp;Video.</strong> Submit a website
              URL that we capture (screenshot) server-side and turn into a
              branded showcase video.
            </li>
            <li>
              <strong>Talking-host / avatar videos.</strong> Turn a script you
              provide into a narrated video using text-to-speech.
            </li>
            <li>
              <strong>Render and download.</strong> Render your projects to
              video files (such as MP4) and stream or download the result.
            </li>
          </ul>
          <p>
            The Service is currently offered in a private alpha. Features may be
            added, changed, suspended, or removed at any time, and availability,
            quality, and output are not guaranteed. We may impose or adjust
            usage limits, including rate limits and monthly quotas, in our
            reasonable discretion.
          </p>

          <h2>5. Beta and preview features</h2>
          <p>
            Some parts of the Service may be labeled alpha, beta, preview,
            experimental, or &ldquo;coming soon&rdquo; (for example, certain
            bulk, analytics, or collaboration capabilities). These features are
            provided on an &ldquo;as is&rdquo; and &ldquo;as available&rdquo;
            basis for evaluation, may be incomplete or unstable, may change or
            be discontinued without notice, and may be subject to additional
            terms. You use beta features at your own risk.
          </p>

          <h2>6. Subscriptions, plans, and billing</h2>
          <p>
            The Service offers a free plan and one or more paid
            (&ldquo;Pro&rdquo;) plans. Current features and prices are described
            on our <Link href="/pricing">pricing page</Link> and may change as
            described below.
          </p>
          <ul>
            <li>
              <strong>Free plan.</strong> The free plan includes a limited
              monthly allowance of renders and AI generations (currently 3
              renders and 10 AI generations per calendar month) and other
              limits. Videos produced on the free plan include a Sorrel
              watermark (see Section 7).
            </li>
            <li>
              <strong>Pro plan.</strong> Paid plans unlock higher or unlimited
              usage and additional capabilities as described on the pricing
              page. Quotas and included features may be adjusted over time.
            </li>
          </ul>
          <p>
            <strong>Payment processor.</strong> Payments are processed by
            Stripe, our third-party payment processor. We do not collect or
            store your full payment card details; your payment information is
            handled by Stripe under its own terms and privacy policy. You must
            provide a valid payment method and authorize us and Stripe to charge
            it for all applicable fees and taxes.
          </p>
          <p>
            <strong>Auto-renewal.</strong> Paid subscriptions are billed in
            advance on a recurring basis (for example, monthly) and{" "}
            <strong>automatically renew</strong> for successive periods at the
            then-current price until cancelled. By subscribing, you authorize
            recurring charges to your payment method for each renewal period.
          </p>
          <p>
            <strong>Cancellation.</strong> You may cancel your subscription at
            any time through the in-app billing settings, which open the Stripe
            Customer Portal. Cancellation takes effect at the end of the current
            billing period: you keep Pro access until the period ends, after
            which your account reverts to the free plan. Cancelling stops future
            renewals but does not, by itself, terminate your account.
          </p>
          <p>
            <strong>Price changes.</strong> We may change subscription prices or
            the contents of a plan. We will give you reasonable advance notice
            of a price increase, and it will apply to the next renewal after the
            notice. Your continued use after a price change takes effect
            constitutes acceptance of the new price.
          </p>
          <p>
            <strong>Refunds.</strong> Except where required by applicable law,
            payments are non-refundable and we do not provide refunds or credits
            for partial subscription periods, unused quota, downgrades, or
            features that are removed or modified. If you believe you were
            charged in error, contact us at{" "}
            <a href="mailto:support@sorrel.video">support@sorrel.video</a> and
            we will review your request in good faith. Nothing in this section
            limits any non-waivable statutory refund or cancellation rights you
            may have.
          </p>
          <p>
            <strong>Taxes.</strong> Fees are exclusive of taxes unless stated
            otherwise. You are responsible for any sales, use, value-added, or
            similar taxes, excluding taxes based on our net income.
          </p>

          <h2>7. Watermark on the free tier</h2>
          <p>
            Videos rendered on the free plan are produced with a Sorrel
            watermark burned into the output. Removal of the watermark is a paid
            feature available on Pro plans. You agree not to remove, obscure, or
            alter the watermark on free-tier output, or to use any method to
            circumvent watermarking or other plan limitations.
          </p>

          <h2>8. Acceptable use</h2>
          <p>You agree that you will not, and will not permit anyone to:</p>
          <ul>
            <li>
              violate any applicable law or regulation, or infringe or
              misappropriate any third-party right, including intellectual
              property, privacy, publicity, or contractual rights;
            </li>
            <li>
              create, upload, generate, or distribute content that is unlawful,
              fraudulent, defamatory, harassing, hateful, obscene, sexually
              explicit involving minors, or that promotes violence or illegal
              activity;
            </li>
            <li>
              use the Website&nbsp;&rarr;&nbsp;Video feature (or any capture
              feature) to capture, screenshot, or reproduce any website or
              content that you do not own or do not have the necessary rights
              and permissions to use, or in violation of a site&rsquo;s terms;
            </li>
            <li>
              submit URLs, hostnames, IP addresses, or requests that target
              internal, private, local, loopback, link-local, or cloud-metadata
              endpoints, or otherwise attempt to use the Service to probe,
              access, or attack systems or networks you are not authorized to
              reach (including server-side request forgery);
            </li>
            <li>
              upload or transmit viruses, malware, or other harmful code, or
              attempt to gain unauthorized access to the Service, other
              accounts, or our systems;
            </li>
            <li>
              reverse engineer, decompile, scrape, data-mine, or create
              derivative works of the Service, except to the extent this
              restriction is prohibited by law;
            </li>
            <li>
              interfere with, overload, or disrupt the Service or its
              infrastructure, or circumvent any rate limit, quota, security
              measure, or access control;
            </li>
            <li>
              use the Service to build a competing product, or resell,
              sublicense, or make the Service available to third parties except
              as expressly permitted;
            </li>
            <li>
              use the AI features to generate content that is misleading,
              deceptive, or that impersonates a real person without
              authorization, or that otherwise violates this Acceptable Use
              section.
            </li>
          </ul>
          <p>
            We may, but are not obligated to, monitor use of the Service and may
            investigate and take appropriate action, including removing content
            and suspending or terminating accounts, for any actual or suspected
            violation of these Terms.
          </p>

          <h2>9. Your content and license</h2>
          <p>
            &ldquo;User Content&rdquo; means the text, images, logos, brand
            assets, scripts, prompts, website URLs, and other materials you
            upload, submit, or generate through the Service, as well as the
            videos rendered from them. As between you and us, you retain all
            ownership rights you hold in your User Content.
          </p>
          <p>
            You grant us a limited, worldwide, non-exclusive, royalty-free
            license to host, store, reproduce, process, transcode, render,
            display, and transmit your User Content solely as necessary to
            operate and provide the Service to you, to maintain and improve the
            Service, and to comply with the law. This license ends when your
            User Content is deleted from the Service, except for residual copies
            retained for a reasonable period in backups or as required by law.
          </p>
          <p>
            You are solely responsible for your User Content and represent and
            warrant that you own or have all rights, licenses, consents, and
            permissions necessary to use it and to grant the license above,
            including rights to any logos, brand assets, third-party material,
            and any website or URL you ask us to capture, and that your User
            Content and its use do not violate these Terms or any third-party
            right or applicable law.
          </p>

          <h2>10. AI-generated output</h2>
          <p>
            AI features generate suggestions based on the inputs you provide. AI
            output may be inaccurate, incomplete, or unsuitable, may resemble
            content generated for other users, and is not guaranteed to be
            original or to be free of third-party rights. You are responsible
            for reviewing AI output before relying on or publishing it, and for
            ensuring your use complies with applicable law and any third-party
            terms. We make no representation that AI output is fit for any
            particular purpose.
          </p>

          <h2>11. Our intellectual property</h2>
          <p>
            The Service, including its software, templates and compositions we
            author, design system, user interface, text, graphics, logos, and
            the Sorrel name and marks, is owned by us or our licensors and is
            protected by intellectual property and other laws. Except for the
            rights expressly granted to you in these Terms, we reserve all
            rights, title, and interest in and to the Service. We grant you a
            limited, revocable, non-exclusive, non-transferable license to
            access and use the Service in accordance with these Terms. You may
            use videos you create with the Service, including for commercial
            purposes, subject to your compliance with these Terms and your
            responsibility for the rights in your User Content.
          </p>
          <p>
            We welcome feedback and suggestions. If you provide them, you grant
            us a perpetual, irrevocable, royalty-free license to use them
            without restriction or obligation to you.
          </p>

          <h2>12. Third-party services</h2>
          <p>
            The Service relies on third-party providers to function, including
            Stripe (payment processing), Google Cloud Storage (file storage),
            our email provider (transactional email), and AI providers such as
            Anthropic or OpenAI (AI features). When you use related features,
            your data may be processed by these providers as described in our{" "}
            <Link href="/privacy">Privacy Policy</Link>. Your use of third-party
            services may be subject to their own terms and policies, and we are
            not responsible for the acts, omissions, content, or availability of
            third parties.
          </p>

          <h2>13. Suspension and termination</h2>
          <p>
            You may stop using the Service and may delete your account at any
            time. We may suspend, restrict, or terminate your access to the
            Service, with or without notice, if you breach these Terms, if your
            use poses a security, legal, or operational risk, if required by
            law, or if we discontinue the Service. We may also terminate or
            modify free or beta access at any time.
          </p>
          <p>
            Upon termination, your right to use the Service ceases. We may
            delete your account and User Content subject to our retention
            practices and the Privacy Policy, although certain records (such as
            billing records) may be retained as required by law. Sections that
            by their nature should survive termination — including ownership,
            license grants to us, disclaimers, limitation of liability,
            indemnification, and governing law — survive.
          </p>

          <h2>14. Disclaimers</h2>
          <p>
            THE SERVICE, INCLUDING ALL CONTENT, TEMPLATES, AI OUTPUT, AND VIDEOS
            PRODUCED THROUGH IT, IS PROVIDED ON AN &ldquo;AS IS&rdquo; AND
            &ldquo;AS AVAILABLE&rdquo; BASIS, WITHOUT WARRANTIES OF ANY KIND,
            WHETHER EXPRESS, IMPLIED, OR STATUTORY. TO THE MAXIMUM EXTENT
            PERMITTED BY LAW, WE DISCLAIM ALL WARRANTIES, INCLUDING IMPLIED
            WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE,
            TITLE, AND NON-INFRINGEMENT, AND ANY WARRANTIES ARISING FROM COURSE
            OF DEALING OR USAGE OF TRADE. WE DO NOT WARRANT THAT THE SERVICE
            WILL BE UNINTERRUPTED, TIMELY, SECURE, ERROR-FREE, OR THAT DEFECTS
            WILL BE CORRECTED, OR THAT ANY OUTPUT WILL MEET YOUR REQUIREMENTS.
            SOME JURISDICTIONS DO NOT ALLOW THE EXCLUSION OF CERTAIN WARRANTIES,
            SO SOME OF THE ABOVE MAY NOT APPLY TO YOU.
          </p>

          <h2>15. Limitation of liability</h2>
          <p>
            TO THE MAXIMUM EXTENT PERMITTED BY LAW, IN NO EVENT WILL SORREL OR
            ITS OFFICERS, EMPLOYEES, OR SUPPLIERS BE LIABLE FOR ANY INDIRECT,
            INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES,
            OR FOR ANY LOSS OF PROFITS, REVENUE, DATA, GOODWILL, OR BUSINESS,
            ARISING OUT OF OR RELATED TO THESE TERMS OR YOUR USE OF (OR
            INABILITY TO USE) THE SERVICE, WHETHER BASED ON WARRANTY, CONTRACT,
            TORT, OR ANY OTHER LEGAL THEORY, AND WHETHER OR NOT WE HAVE BEEN
            ADVISED OF THE POSSIBILITY OF SUCH DAMAGES. OUR TOTAL CUMULATIVE
            LIABILITY FOR ALL CLAIMS ARISING OUT OF OR RELATED TO THESE TERMS OR
            THE SERVICE WILL NOT EXCEED THE GREATER OF (A) THE AMOUNTS YOU PAID
            US FOR THE SERVICE IN THE TWELVE MONTHS BEFORE THE EVENT GIVING RISE
            TO THE LIABILITY, OR (B) ONE HUNDRED U.S. DOLLARS (USD&nbsp;$100).
            SOME JURISDICTIONS DO NOT ALLOW CERTAIN LIMITATIONS, SO SOME OF THE
            ABOVE MAY NOT APPLY TO YOU.
          </p>

          <h2>16. Indemnification</h2>
          <p>
            You agree to defend, indemnify, and hold harmless Sorrel and its
            officers, employees, and agents from and against any claims,
            liabilities, damages, losses, and expenses, including reasonable
            legal fees, arising out of or related to: (a) your User Content; (b)
            your use of the Service; (c) your violation of these Terms or any
            applicable law; or (d) your violation of any third-party right,
            including any claim that your User Content or any website or URL you
            asked us to capture infringes or misappropriates a third
            party&apos;s rights. We may assume the exclusive defense and control
            of any matter subject to indemnification, in which case you agree to
            cooperate with us.
          </p>

          <h2>17. Changes to these Terms</h2>
          <p>
            We may update these Terms from time to time. If we make material
            changes, we will take reasonable steps to notify you, such as
            updating the &ldquo;Last updated&rdquo; date above, posting a notice
            in the Service, or emailing you. Changes are effective when posted
            unless stated otherwise. Your continued use of the Service after the
            changes take effect constitutes your acceptance of the revised
            Terms. If you do not agree to the changes, you must stop using the
            Service.
          </p>

          <h2>18. Governing law and disputes</h2>
          <p>
            These Terms and any dispute arising out of or relating to them or
            the Service are governed by the laws of{" "}
            <strong>{GOVERNING_LAW}</strong>, without regard to its
            conflict-of-laws rules. You and Sorrel agree to submit to the
            exclusive jurisdiction of the competent courts of{" "}
            <strong>{GOVERNING_LAW}</strong> to resolve any dispute, except that
            we may seek injunctive relief in any court of competent jurisdiction
            to protect our intellectual property or confidential information.
            Nothing in this section deprives you of the protection of mandatory
            consumer-protection laws of your place of residence.
          </p>

          <h2>19. General</h2>
          <p>
            These Terms, together with the Privacy Policy and any plan-specific
            or feature-specific terms, are the entire agreement between you and
            us regarding the Service and supersede any prior agreements. If any
            provision is held unenforceable, the remaining provisions remain in
            full effect. Our failure to enforce a provision is not a waiver. You
            may not assign or transfer these Terms without our prior written
            consent; we may assign them in connection with a merger,
            acquisition, or sale of assets. Headings are for convenience only.
          </p>

          <h2>20. Contact</h2>
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
