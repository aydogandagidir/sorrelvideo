import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  FolderOpen,
  Palette,
  Menu,
  LogOut,
  Wand2,
  Zap,
  BarChart3,
  Globe,
  Film,
  Clapperboard,
  Bot,
  Search,
  Bell,
  ChevronRight,
  type LucideIcon,
} from "lucide-react";
import { useBillingInfo } from "@/hooks/useBilling";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { RenderTray } from "@/components/render-tray";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@workspace/auth-web";
import { cn } from "@/lib/utils";

interface NavEntry {
  href: string;
  label: string;
  icon: LucideIcon;
  kbd?: string;
  soon?: boolean;
  /**
   * The target lives OUTSIDE the SPA (e.g. the same-origin `/editor/` mount,
   * a separately-built @hyperframes/studio app served by express.static). Such
   * entries render a plain `<a>` for a real browser navigation instead of a
   * wouter client-side route — a `<Link>` would try to client-route and hit the
   * SPA's NotFound.
   */
  external?: boolean;
}

const NAV: NavEntry[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/studio", label: "Studio", icon: Wand2, kbd: "S" },
  // The full timeline editor (@hyperframes/studio) is a separate same-origin
  // build mounted at /editor/ — open it with a real navigation, not a route.
  { href: "/editor/", label: "Editor", icon: Clapperboard, external: true },
  { href: "/projects", label: "Projects", icon: FolderOpen },
  { href: "/templates", label: "Templates", icon: Film },
  { href: "/brand", label: "Brand DNA", icon: Palette },
];

// Shipped modules only. Website → Video, Live Avatar, and Analytics are live;
// Bulk (batch render) and Collab (sharing/members) are built but not finished, so
// they are hidden from the nav until they ship — their routes still resolve for
// deep links. Re-add them here (with a `soon` badge or as live) when complete.
const MODULES: NavEntry[] = [
  { href: "/website-to-video", label: "Website → Video", icon: Globe },
  { href: "/avatar", label: "Live Avatar", icon: Bot },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
];

const ROUTE_TITLES: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/studio": "Studio",
  "/projects": "Projects",
  "/templates": "Templates",
  "/brand": "Brand DNA",
  "/website-to-video": "Website → Video",
  "/avatar": "Live Avatar",
  "/bulk": "Bulk",
  "/analytics": "Analytics",
  "/collab": "Collab",
  "/modules": "Modules",
  "/settings": "Settings",
};

/** The Sorrel leaf mark on a lime tile (ported from the handoff). */
function SorrelMark() {
  return (
    <div
      className="grid h-7 w-7 place-items-center rounded-lg bg-primary"
      style={{ boxShadow: "0 4px 14px hsl(var(--primary)/0.3)" }}
    >
      <svg
        width="17"
        height="17"
        viewBox="0 0 24 24"
        fill="none"
        stroke="hsl(var(--primary-foreground))"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 3c4 2 5 7 3 11-1 2-3 4-3 7 0-3-2-5-3-7-2-4-1-9 3-11z" />
        <path d="M12 8v9" />
      </svg>
    </div>
  );
}

function NavItem({
  item,
  active,
  onNavigate,
}: {
  item: NavEntry;
  active: boolean;
  onNavigate?: () => void;
}) {
  const className = cn(
    "relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13.5px] transition-colors",
    active
      ? "bg-primary/[0.13] font-semibold text-primary"
      : "font-medium text-muted-foreground hover:bg-secondary hover:text-foreground",
  );
  const inner = (
    <>
      {active && (
        <span className="absolute -left-3 top-1/2 h-[18px] w-[3px] -translate-y-1/2 rounded-full bg-primary" />
      )}
      <item.icon className="h-[17px] w-[17px]" />
      <span className="flex-1">{item.label}</span>
      {item.soon ? (
        <span className="rounded border border-border px-1.5 py-px text-[9.5px] font-bold uppercase tracking-wider text-muted-foreground/60">
          Soon
        </span>
      ) : item.kbd ? (
        <span className="font-mono text-[10px] text-muted-foreground/50">
          {item.kbd}
        </span>
      ) : null}
    </>
  );
  // External entries (e.g. the /editor/ mount) leave the SPA — use a real anchor
  // so the browser navigates instead of wouter client-routing into NotFound.
  if (item.external) {
    return (
      <a href={item.href} onClick={onNavigate} className={className}>
        {inner}
      </a>
    );
  }
  return (
    <Link href={item.href} onClick={onNavigate} className={className}>
      {inner}
    </Link>
  );
}

function PlanCard() {
  const { data: billing } = useBillingInfo();
  if (billing?.plan === "pro") {
    return (
      <div className="flex items-center gap-2.5 rounded-xl border border-primary/20 bg-primary/[0.08] px-3 py-2.5">
        <div className="grid h-[30px] w-[30px] place-items-center rounded-lg bg-primary/[0.16] text-primary">
          <Zap className="h-[15px] w-[15px]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-bold text-primary">
            Pro · Unlimited
          </div>
          <div className="text-[10.5px] text-muted-foreground">
            Renders &amp; AI uncapped
          </div>
        </div>
      </div>
    );
  }
  return (
    <Link
      href="/settings"
      className="flex items-center gap-2.5 rounded-xl border border-border bg-secondary px-3 py-2.5 transition-colors hover:border-primary/40"
    >
      <div className="grid h-[30px] w-[30px] place-items-center rounded-lg bg-muted text-muted-foreground">
        <Zap className="h-[15px] w-[15px]" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-bold">Free plan</div>
        <div className="text-[10.5px] text-muted-foreground">
          {billing?.renderLimit != null
            ? `${billing.renderCount}/${billing.renderLimit} renders · Upgrade`
            : "Upgrade to Pro"}
        </div>
      </div>
    </Link>
  );
}

function UserRow() {
  const { user, logout } = useAuth();
  if (!user) return null;
  const initials =
    [user.firstName, user.lastName]
      .filter((n): n is string => Boolean(n))
      .map((n) => n[0]?.toUpperCase() ?? "")
      .join("") ||
    user.email?.[0]?.toUpperCase() ||
    "U";
  const displayName =
    [user.firstName, user.lastName].filter(Boolean).join(" ") ||
    user.email ||
    "User";
  return (
    <div className="flex items-center gap-2.5">
      <Link href="/settings" className="flex min-w-0 flex-1 items-center gap-2.5">
        <Avatar className="h-8 w-8">
          {user.profileImageUrl && (
            <AvatarImage src={user.profileImageUrl} alt={displayName} />
          )}
          <AvatarFallback className="bg-primary/15 text-xs text-primary">
            {initials}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold">{displayName}</div>
          {user.email && (
            <div className="truncate text-[11px] text-muted-foreground">
              {user.email}
            </div>
          )}
        </div>
      </Link>
      <button
        type="button"
        onClick={logout}
        aria-label="Log out"
        className="text-muted-foreground transition-colors hover:text-foreground"
      >
        <LogOut className="h-[15px] w-[15px]" />
      </button>
    </div>
  );
}

/** The sidebar body, shared by the desktop aside and the mobile Sheet. */
function SidebarBody({
  active,
  onNavigate,
}: {
  active: (href: string) => boolean;
  onNavigate?: () => void;
}) {
  return (
    <>
      <div className="flex h-[60px] items-center gap-2.5 border-b px-[18px]">
        <SorrelMark />
        <span
          className="text-[18px] font-bold tracking-tight"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Sorrel
        </span>
        <span className="ml-auto font-mono text-[9.5px] font-bold text-muted-foreground/50">
          v1.0
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 py-3.5">
        {NAV.map((item) => (
          <NavItem
            key={item.href}
            item={item}
            active={active(item.href)}
            onNavigate={onNavigate}
          />
        ))}
        <div className="px-2 pb-1.5 pt-4 text-[10.5px] font-bold uppercase tracking-[0.1em] text-muted-foreground/50">
          Modules
        </div>
        {MODULES.map((item) => (
          <NavItem
            key={item.href}
            item={item}
            active={active(item.href)}
            onNavigate={onNavigate}
          />
        ))}
      </div>
      <div className="border-t px-4 py-3">
        <PlanCard />
      </div>
      <div className="border-t px-4 py-3">
        <UserRow />
      </div>
    </>
  );
}

function Topbar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const [location] = useLocation();
  const { toast } = useToast();
  const title = ROUTE_TITLES[location] ?? "Sorrel";
  return (
    <header className="sticky top-0 z-20 flex h-[60px] shrink-0 items-center gap-3.5 border-b bg-background/80 px-6 backdrop-blur-md">
      <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <span>Sorrel</span>
        <ChevronRight className="h-[13px] w-[13px]" />
        <span className="font-semibold text-foreground">{title}</span>
      </div>
      <div className="flex-1" />
      <button
        type="button"
        onClick={onOpenPalette}
        className="flex h-[34px] w-[210px] items-center gap-2 rounded-md border bg-secondary px-2.5 text-muted-foreground transition-colors hover:border-muted-foreground/40"
      >
        <Search className="h-[15px] w-[15px]" />
        <span className="text-[13px]">Search…</span>
        <span className="ml-auto rounded border px-1.5 py-px font-mono text-[10.5px]">
          ⌘K
        </span>
      </button>
      <button
        type="button"
        onClick={() => toast({ title: "You're all caught up" })}
        aria-label="Notifications"
        className="relative grid h-[34px] w-[34px] place-items-center rounded-md border bg-secondary text-muted-foreground transition-colors hover:text-foreground"
      >
        <Bell className="h-4 w-4" />
        <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-spark" />
      </button>
    </header>
  );
}

function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [, setLocation] = useLocation();
  const go = (item: NavEntry) => {
    onOpenChange(false);
    // External entries (/editor/) need a real navigation, not a client route.
    if (item.external) {
      window.location.href = item.href;
    } else {
      setLocation(item.href);
    }
  };
  const all = [...NAV, ...MODULES];
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Jump to…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Go to">
          {all.map((item) => (
            <CommandItem
              key={item.href}
              value={item.label}
              onSelect={() => go(item)}
            >
              <item.icon className="mr-2 h-4 w-4" />
              {item.label}
              {item.soon && (
                <span className="ml-auto text-[10px] uppercase text-muted-foreground/60">
                  Soon
                </span>
              )}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const active = (href: string) =>
    location === href || location.startsWith(`${href}/`);

  // Global shortcuts: ⌘K / Ctrl+K toggles the palette; single keys jump (when
  // not typing and the palette is closed) — mirrors the handoff's Shortcuts.
  useEffect(() => {
    const JUMP: Record<string, string> = {
      s: "/studio",
      d: "/dashboard",
      p: "/projects",
      t: "/templates",
      b: "/brand",
    };
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const typing =
        !!el &&
        (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const dest = JUMP[e.key.toLowerCase()];
      if (dest) {
        e.preventDefault();
        setLocation(dest);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setLocation]);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background text-foreground">
      {/* Desktop sidebar */}
      <aside className="hidden w-[248px] shrink-0 flex-col border-r bg-sidebar md:flex">
        <SidebarBody active={active} />
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Mobile header */}
        <header className="flex h-[60px] items-center justify-between border-b px-4 md:hidden">
          <Link href="/" className="flex items-center gap-2">
            <SorrelMark />
            <span
              className="text-lg font-bold"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Sorrel
            </span>
          </Link>
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon">
                <Menu className="h-5 w-5" />
                <span className="sr-only">Toggle navigation</span>
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="flex w-[248px] flex-col bg-sidebar p-0">
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <SidebarBody active={active} onNavigate={() => setMobileOpen(false)} />
            </SheetContent>
          </Sheet>
        </header>

        {/* Desktop topbar */}
        <div className="hidden md:block">
          <Topbar onOpenPalette={() => setPaletteOpen(true)} />
        </div>

        <main className="flex-1 overflow-y-auto px-6 pb-16 pt-6 lg:px-8">
          {children}
        </main>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <RenderTray />
    </div>
  );
}
