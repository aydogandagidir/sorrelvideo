import React from "react";
import { Link, useLocation } from "wouter";
import { 
  LayoutDashboard, 
  Film, 
  FolderOpen, 
  Palette, 
  Blocks,
  Menu,
  Video
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/projects", label: "Projects", icon: FolderOpen },
  { href: "/templates", label: "Templates", icon: Film },
  { href: "/brand", label: "Brand Kit", icon: Palette },
  { href: "/modules", label: "Modules", icon: Blocks },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  const isCurrentPage = (href: string) => {
    return location === href || location.startsWith(`${href}/`);
  };

  return (
    <div className="flex min-h-screen w-full bg-background text-foreground">
      {/* Desktop Sidebar */}
      <aside className="hidden border-r bg-sidebar md:block md:w-64 lg:w-72">
        <div className="flex h-16 items-center border-b px-6">
          <Link href="/" className="flex items-center gap-2 font-bold text-lg tracking-tight">
            <Video className="h-5 w-5 text-primary" />
            <span>Sorrel</span>
          </Link>
        </div>
        <div className="p-4">
          <nav className="grid gap-1">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const isActive = isCurrentPage(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
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
        </div>
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
            <SheetContent side="left" className="w-64 bg-sidebar p-0">
              <div className="flex h-16 items-center border-b px-6">
                <div className="flex items-center gap-2 font-bold text-lg">
                  <Video className="h-5 w-5 text-primary" />
                  <span>Sorrel</span>
                </div>
              </div>
              <div className="p-4">
                <nav className="grid gap-1">
                  {NAV_ITEMS.map((item) => {
                    const Icon = item.icon;
                    const isActive = isCurrentPage(item.href);
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
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
              </div>
            </SheetContent>
          </Sheet>
        </header>

        <main className="flex-1 overflow-y-auto p-4 md:p-8">
          <div className="mx-auto max-w-6xl">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
