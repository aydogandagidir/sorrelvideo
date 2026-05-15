import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  Film,
  FolderOpen,
  Palette,
  Blocks,
  Menu,
  Video,
  LogOut,
  User,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useAuth } from "@workspace/replit-auth-web";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/projects", label: "Projects", icon: FolderOpen },
  { href: "/templates", label: "Templates", icon: Film },
  { href: "/brand", label: "Brand Kit", icon: Palette },
  { href: "/modules", label: "Modules", icon: Blocks },
];

function UserFooter() {
  const { user, logout } = useAuth();

  if (!user) return null;

  const initials = [user.firstName, user.lastName]
    .filter(Boolean)
    .map((n) => n![0].toUpperCase())
    .join("") || user.email?.[0]?.toUpperCase() || "U";

  const displayName =
    [user.firstName, user.lastName].filter(Boolean).join(" ") ||
    user.email ||
    "User";

  return (
    <div className="border-t p-4">
      <div className="flex items-center gap-3 mb-3">
        <Avatar className="h-8 w-8">
          {user.profileImageUrl && (
            <AvatarImage src={user.profileImageUrl} alt={displayName} />
          )}
          <AvatarFallback className="bg-primary/10 text-primary text-xs">
            {initials}
          </AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{displayName}</p>
          {user.email && (
            <p className="text-xs text-muted-foreground truncate">{user.email}</p>
          )}
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground"
        onClick={logout}
      >
        <LogOut className="h-4 w-4" />
        Log out
      </Button>
    </div>
  );
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const [location] = useLocation();

  const isCurrentPage = (href: string) =>
    location === href || location.startsWith(`${href}/`);

  return (
    <nav className="grid gap-1">
      {NAV_ITEMS.map((item) => {
        const Icon = item.icon;
        const isActive = isCurrentPage(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              isActive
                ? "bg-primary text-primary-foreground"
                : "hover:bg-muted text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon className="h-4 w-4" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen w-full bg-background text-foreground">
      {/* Desktop Sidebar */}
      <aside className="hidden border-r bg-sidebar md:flex md:w-64 lg:w-72 flex-col">
        <div className="flex h-16 items-center border-b px-6">
          <Link href="/" className="flex items-center gap-2 font-bold text-lg tracking-tight">
            <Video className="h-5 w-5 text-primary" />
            <span>Sorrel</span>
          </Link>
        </div>
        <div className="flex-1 p-4 overflow-y-auto">
          <NavLinks />
        </div>
        <UserFooter />
      </aside>

      {/* Mobile Header & Content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-16 items-center justify-between border-b bg-background px-4 md:hidden">
          <Link href="/" className="flex items-center gap-2 font-bold text-lg">
            <Video className="h-5 w-5 text-primary" />
            <span>Sorrel</span>
          </Link>
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="md:hidden">
                <Menu className="h-5 w-5" />
                <span className="sr-only">Toggle navigation menu</span>
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 bg-sidebar p-0 flex flex-col">
              <div className="flex h-16 items-center border-b px-6">
                <div className="flex items-center gap-2 font-bold text-lg">
                  <Video className="h-5 w-5 text-primary" />
                  <span>Sorrel</span>
                </div>
              </div>
              <div className="flex-1 p-4 overflow-y-auto">
                <NavLinks />
              </div>
              <UserFooter />
            </SheetContent>
          </Sheet>
        </header>

        <main className="flex-1 overflow-y-auto p-4 md:p-8">
          <div className="mx-auto max-w-6xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
