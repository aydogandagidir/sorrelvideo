import React from "react";
import { Link } from "wouter";
import { motion, useScroll, useTransform } from "framer-motion";
import { ArrowRight, Video, Zap, Layers, Sparkles, MonitorPlay } from "lucide-react";
import { Button } from "@/components/ui/button";

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
          Hyperframes Engine 2.0 Now Available
        </div>
        
        <h1 className="font-sans text-5xl font-extrabold tracking-tight sm:text-6xl md:text-7xl lg:text-8xl">
          Code the logic. <br />
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-primary/60">
            Create the video.
          </span>
        </h1>
        
        <p className="max-w-2xl text-lg text-muted-foreground sm:text-xl">
          Sorrel is the creative workspace built on top of the Hyperframes engine. 
          Wrap your programmatic video primitives into a polished SaaS platform for your marketing team.
        </p>
        
        <div className="flex flex-col sm:flex-row gap-4">
          <Link href="/dashboard" className="inline-flex h-12 items-center justify-center rounded-md bg-primary px-8 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50">
            Enter Workspace
          </Link>
          <Button variant="outline" size="lg" className="h-12 px-8">
            View Documentation
          </Button>
        </div>
      </motion.div>
    </section>
  );
}

function FeatureCard({ icon: Icon, title, description, delay }: { icon: any, title: string, description: string, delay: number }) {
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
      <header className="fixed top-0 z-50 w-full border-b bg-background/80 backdrop-blur-md">
        <div className="container mx-auto flex h-16 items-center justify-between px-4">
          <Link href="/" className="flex items-center gap-2 font-bold text-lg tracking-tight">
            <Video className="h-5 w-5 text-primary" />
            <span>Sorrel</span>
          </Link>
          <nav className="hidden md:flex gap-6 text-sm font-medium">
            <a href="#features" className="text-muted-foreground hover:text-foreground transition-colors">Features</a>
            <a href="#modules" className="text-muted-foreground hover:text-foreground transition-colors">Modules</a>
            <a href="#pricing" className="text-muted-foreground hover:text-foreground transition-colors">Pricing</a>
          </nav>
          <Link href="/dashboard" className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90">
            Open App <ArrowRight className="ml-2 h-4 w-4" />
          </Link>
        </div>
      </header>

      <main>
        <HeroSection />

        <section id="features" className="py-24 px-4 container mx-auto max-w-6xl">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">The Production Studio</h2>
            <p className="mt-4 text-muted-foreground max-w-2xl mx-auto">
              Built for speed, precision, and scale. Bring your technical primitives to the creative team.
            </p>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <FeatureCard 
              delay={0.1}
              icon={Zap}
              title="Lightning Fast"
              description="Render videos in seconds, not hours. Hyperframes engine optimized for speed."
            />
            <FeatureCard 
              delay={0.2}
              icon={Layers}
              title="Modular Architecture"
              description="Pick and choose the modules you need. Studio, Bulk, AI, and more."
            />
            <FeatureCard 
              delay={0.3}
              icon={MonitorPlay}
              title="Real-time Preview"
              description="See changes instantly. No waiting for renders just to see a typo fix."
            />
          </div>
        </section>

        <section className="py-24 px-4 bg-muted/30 border-y">
          <div className="container mx-auto max-w-4xl text-center">
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl mb-8">Ready to scale your video production?</h2>
            <Link href="/dashboard" className="inline-flex h-14 items-center justify-center rounded-md bg-primary px-8 text-base font-bold text-primary-foreground transition-colors hover:bg-primary/90">
              Go to Workspace <ArrowRight className="ml-2 h-5 w-5" />
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
          <p className="text-sm text-muted-foreground">
            © {new Date().getFullYear()} Sorrel Platform. Built on Hyperframes.
          </p>
        </div>
      </footer>
    </div>
  );
}
