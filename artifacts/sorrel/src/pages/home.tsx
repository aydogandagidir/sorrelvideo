import React from "react";
import { Link } from "wouter";
import { motion } from "framer-motion";
import { ArrowRight, Video, Zap, Sparkles, Check as CheckIcon, Film, Globe, Clapperboard } from "lucide-react";
import { useBillingPrices } from "@/hooks/useBilling";
import { FREE_PLAN_FEATURES, PRO_PLAN_FEATURES } from "@/lib/plans";
import { MarketingHeader } from "@/components/marketing-header";

function HeroSection() {
  return (
    <section className="relative min-h-[90vh] flex flex-col items-center justify-center overflow-hidden bg-background px-4 py-20 text-center">
      <div className="absolute inset-0 z-0 bg-[radial-gradient(circle_at_center,var(--color-primary)_0,transparent_20%)] opacity-[0.03] blur-3xl"></div>
      
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        className="z-10 flex max-w-4xl flex-col items-center gap-8"
      >
        <div className="inline-flex items-center rounded-full border border-primary/20 bg-primary/5 px-3 py-1 text-sm font-medium text-primary">
          <Sparkles className="mr-2 h-3.5 w-3.5" />
          Now in private alpha
        </div>
        
        <h1 className="font-sans text-5xl font-extrabold tracking-tight sm:text-6xl md:text-7xl lg:text-8xl">
          Code the logic. <br />
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-primary/60">
            Create the video.
          </span>
        </h1>
        
        <p className="max-w-2xl text-lg text-muted-foreground sm:text-xl">
          Turn a template, your website, or a script into branded short-form
          video in minutes — no editor, no render farm, no waiting.
        </p>

        <div className="flex flex-col items-center gap-3">
          <Link href="/signup" className="inline-flex h-12 items-center justify-center rounded-md bg-primary px-8 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50">
            Start free — no card required
          </Link>
          <span className="text-xs text-muted-foreground">
            Free plan included · upgrade anytime · secured by Stripe
          </span>
        </div>
      </motion.div>
    </section>
  );
}

function ProPrice() {
  const { data: pricesData } = useBillingPrices();
  const monthly = pricesData?.prices?.find((p) => p.interval === "month");
  const display = monthly
    ? `$${((monthly.unitAmount ?? 0) / 100).toFixed(0)}`
    : "$29";
  return (
    <div className="flex items-baseline gap-1">
      <span className="text-4xl font-extrabold">{display}</span>
      <span className="text-muted-foreground">/month</span>
    </div>
  );
}

function FeatureCard({ icon: Icon, title, description, delay }: { icon: React.ElementType, title: string, description: string, delay: number }) {
  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-100px" }}
      transition={{ duration: 0.5, delay }}
      className="group relative overflow-hidden rounded-2xl border bg-card p-8 transition-all hover:border-primary/50"
    >
      <div className="mb-6 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <Icon className="h-6 w-6" />
      </div>
      <h3 className="mb-3 text-xl font-bold">{title}</h3>
      <p className="text-muted-foreground">{description}</p>
    </motion.div>
  );
}

export default function Home() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <MarketingHeader />

      <main>
        <HeroSection />

        <section id="features" className="py-24 px-4 container mx-auto max-w-6xl">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Three ways to make a video</h2>
            <p className="mt-4 text-muted-foreground max-w-2xl mx-auto">
              Start from a template, your own website, or a script. Sorrel renders a branded MP4 you can download and share.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <FeatureCard
              delay={0.1}
              icon={Film}
              title="Start from a template"
              description="Pick from a library of branded templates and customize the copy, colors, and logo — render to MP4 in seconds."
            />
            <FeatureCard
              delay={0.2}
              icon={Globe}
              title="Turn your website into video"
              description="Paste a URL and Sorrel captures your site, then produces a branded showcase video automatically."
            />
            <FeatureCard
              delay={0.3}
              icon={Clapperboard}
              title="Script to talking-host"
              description="Write a script and get a branded, lip-synced host video with karaoke captions — no camera, no studio."
            />
          </div>
        </section>

        <section id="pricing" className="py-24 px-4 bg-muted/30 border-y">
          <div className="container mx-auto max-w-5xl">
            <div className="text-center mb-12">
              <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Simple, transparent pricing</h2>
              <p className="mt-4 text-muted-foreground max-w-xl mx-auto">
                Start free, upgrade when you need more. No surprises.
              </p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-3xl mx-auto">
              <div className="rounded-2xl border bg-card p-8 flex flex-col gap-6">
                <div>
                  <h3 className="text-lg font-bold mb-1">Free</h3>
                  <div className="text-4xl font-extrabold">$0</div>
                </div>
                <ul className="space-y-2 flex-1 text-sm text-muted-foreground">
                  {FREE_PLAN_FEATURES.map(f => (
                    <li key={f} className="flex items-center gap-2"><CheckIcon className="h-4 w-4 text-primary shrink-0" />{f}</li>
                  ))}
                </ul>
                <Link href="/signup" className="inline-flex h-10 items-center justify-center rounded-md border border-input bg-background px-4 text-sm font-medium hover:bg-muted transition-colors">
                  Get Started Free
                </Link>
              </div>
              <div className="relative rounded-2xl border border-primary bg-primary/5 p-8 flex flex-col gap-6 shadow-lg shadow-primary/10">
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <span className="inline-flex items-center rounded-full bg-primary px-3 py-0.5 text-xs font-semibold text-primary-foreground">Most Popular</span>
                </div>
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="text-lg font-bold">Pro</h3>
                    <Zap className="h-4 w-4 text-primary" />
                  </div>
                  <ProPrice />
                </div>
                <ul className="space-y-2 flex-1 text-sm">
                  {PRO_PLAN_FEATURES.map(f => (
                    <li key={f} className="flex items-center gap-2"><CheckIcon className="h-4 w-4 text-primary shrink-0" />{f}</li>
                  ))}
                </ul>
                <Link href="/pricing" className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90">
                  <Zap className="mr-2 h-4 w-4" />See Pro plan
                </Link>
              </div>
            </div>
          </div>
        </section>

        <section className="py-24 px-4 bg-background">
          <div className="container mx-auto max-w-4xl text-center">
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl mb-8">Ready to make your first video?</h2>
            <Link href="/signup" className="inline-flex h-14 items-center justify-center rounded-md bg-primary px-8 text-base font-bold text-primary-foreground transition-colors hover:bg-primary/90">
              Create your first video free <ArrowRight className="ml-2 h-5 w-5" />
            </Link>
          </div>
        </section>
      </main>

      <footer className="py-12 border-t bg-background">
        <div className="container mx-auto px-4 flex flex-col md:flex-row justify-between items-center gap-6">
          <div className="flex items-center gap-2 font-bold text-lg tracking-tight">
            <Video className="h-5 w-5 text-primary" />
            <span>Sorrel</span>
          </div>
          <nav className="flex items-center gap-6 text-sm text-muted-foreground">
            <Link href="/terms" className="hover:text-foreground transition-colors">
              Terms
            </Link>
            <Link href="/privacy" className="hover:text-foreground transition-colors">
              Privacy
            </Link>
          </nav>
          <p className="text-sm text-muted-foreground">
            © {new Date().getFullYear()} Sorrel Platform. Built on Hyperframes.
          </p>
        </div>
      </footer>
    </div>
  );
}
