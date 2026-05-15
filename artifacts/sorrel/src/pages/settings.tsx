import { Layout } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useAuth } from "@workspace/replit-auth-web";
import { User, Mail, Shield, LogOut } from "lucide-react";

export default function Settings() {
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
    <Layout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
          <p className="text-muted-foreground">Manage your account and preferences.</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <User className="h-4 w-4" />
              Profile
            </CardTitle>
            <CardDescription>Your account information from your identity provider.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex items-center gap-4">
              <Avatar className="h-16 w-16">
                {user.profileImageUrl && (
                  <AvatarImage src={user.profileImageUrl} alt={displayName} />
                )}
                <AvatarFallback className="bg-primary/10 text-primary text-xl">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <div>
                <p className="text-lg font-semibold">{displayName}</p>
                {user.email && (
                  <p className="text-sm text-muted-foreground flex items-center gap-1">
                    <Mail className="h-3 w-3" />
                    {user.email}
                  </p>
                )}
              </div>
            </div>

            <Separator />

            <div className="grid gap-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">User ID</span>
                <code className="bg-muted px-2 py-0.5 rounded text-xs font-mono truncate max-w-[200px]">
                  {user.id}
                </code>
              </div>
              {user.firstName && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">First name</span>
                  <span>{user.firstName}</span>
                </div>
              )}
              {user.lastName && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Last name</span>
                  <span>{user.lastName}</span>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-4 w-4" />
              Security
            </CardTitle>
            <CardDescription>Authentication and session management.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Authentication status</p>
                <p className="text-xs text-muted-foreground">You are currently signed in.</p>
              </div>
              <Badge variant="secondary" className="text-green-600 bg-green-50">
                Active
              </Badge>
            </div>

            <Separator />

            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Sign out</p>
                <p className="text-xs text-muted-foreground">End your current session on this device.</p>
              </div>
              <Button variant="outline" size="sm" onClick={logout} className="gap-2">
                <LogOut className="h-4 w-4" />
                Log out
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}
