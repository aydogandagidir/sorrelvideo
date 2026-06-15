import React from "react";
import { Layout } from "@/components/layout";
import { useListProjects } from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useAuth } from "@workspace/auth-web";
import {
  AlertCircle,
  Users,
  Share2,
  Film,
  UserPlus,
  Info,
} from "lucide-react";

/**
 * Mirrors the `ModuleStatusBadge` in pages/modules.tsx. Replicated here (rather
 * than imported) because that component is not exported, and these scaffold
 * pages must not modify modules.tsx.
 */
function ModuleStatusBadge({ status }: { status: string }) {
  switch (status) {
    case "active":
      return (
        <Badge className="bg-primary text-primary-foreground">Active</Badge>
      );
    case "beta":
      return (
        <Badge className="border-warning/25 bg-warning/15 text-warning">
          Beta
        </Badge>
      );
    case "coming_soon":
      return (
        <Badge variant="outline" className="text-muted-foreground">
          Coming Soon
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export default function Collab() {
  const { data: projects, isLoading, isError } = useListProjects();
  const { user } = useAuth();

  const ownerInitial =
    user?.firstName?.[0]?.toUpperCase() ??
    user?.email?.[0]?.toUpperCase() ??
    "U";
  const ownerName =
    [user?.firstName, user?.lastName].filter(Boolean).join(" ") ||
    user?.email ||
    "You";

  if (isError) {
    return (
      <Layout>
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>
            Failed to load projects. Please try again later.
          </AlertDescription>
        </Alert>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="flex items-start justify-between mb-8 gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-[27px] leading-tight">Collaboration</h1>
            <ModuleStatusBadge status="coming_soon" />
          </div>
          <p className="text-muted-foreground">
            Share projects with teammates and manage who can view or edit.
          </p>
        </div>
      </div>

      <Alert className="mb-8">
        <Info className="h-4 w-4" />
        <AlertTitle>Coming soon</AlertTitle>
        <AlertDescription>
          Collaboration is not active yet. This is a preview — sharing and
          member management are inert until the Collab module ships.
        </AlertDescription>
      </Alert>

      <div className="grid gap-8 lg:grid-cols-3">
        {/* Shareable projects */}
        <div className="lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Your projects</CardTitle>
              <CardDescription>
                Projects you own. Sharing controls will appear here.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="space-y-3">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-4 rounded-md border p-4"
                    >
                      <Skeleton className="h-10 w-10 rounded-md" />
                      <div className="flex-1 space-y-2">
                        <Skeleton className="h-4 w-1/3" />
                        <Skeleton className="h-3 w-1/4" />
                      </div>
                      <Skeleton className="h-9 w-20" />
                    </div>
                  ))}
                </div>
              ) : projects && projects.length > 0 ? (
                <ul className="space-y-3">
                  {projects.map((project) => (
                    <li
                      key={project.id}
                      className="flex items-center gap-4 rounded-md border p-4"
                    >
                      <div className="inline-flex h-10 w-10 items-center justify-center rounded-md bg-muted shrink-0">
                        <Film className="h-5 w-5 text-muted-foreground" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-medium truncate">{project.name}</p>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Badge
                            variant="outline"
                            className="capitalize text-xs font-normal"
                          >
                            {project.module}
                          </Badge>
                          <span>Private</span>
                        </div>
                      </div>
                      {/* Inert until collaboration ships. */}
                      <Button
                        variant="outline"
                        size="sm"
                        disabled
                        title="Sharing is coming soon"
                      >
                        <Share2 className="mr-2 h-4 w-4" />
                        Share
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="text-center py-12 border rounded-md border-dashed">
                  <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-muted mb-3">
                    <Film className="h-6 w-6 text-muted-foreground" />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    No projects to share yet.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Members panel */}
        <div>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5 text-muted-foreground" />
                Members
              </CardTitle>
              <CardDescription>Who has access to your workspace.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-3">
                <Avatar className="h-9 w-9">
                  <AvatarFallback className="bg-primary/10 text-primary text-xs">
                    {ownerInitial}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{ownerName}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {user?.email ?? ""}
                  </p>
                </div>
                <Badge variant="outline" className="text-muted-foreground">
                  Owner
                </Badge>
              </div>

              <div className="rounded-md border border-dashed p-4 text-center">
                <p className="text-sm text-muted-foreground mb-3">
                  Invite teammates to collaborate on your videos.
                </p>
                {/* Inert until collaboration ships. */}
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  disabled
                  title="Inviting members is coming soon"
                >
                  <UserPlus className="mr-2 h-4 w-4" />
                  Invite member
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </Layout>
  );
}
