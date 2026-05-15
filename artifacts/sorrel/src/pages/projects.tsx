import React, { useState, useEffect, useRef } from "react";
import { Layout } from "@/components/layout";
import {
  useListProjects,
  useCreateProject,
  useDeleteProject,
  useStartProjectRender,
  getListProjectsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, Film, Play, Trash2, Clock, Plus, Loader2, Clapperboard, Video, AlertTriangle } from "lucide-react";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { UpgradeModal } from "@/components/upgrade-modal";

type Project = {
  id: number;
  name: string;
  status: string;
  module: string;
  thumbnailUrl?: string | null;
  videoUrl?: string | null;
  duration?: number | null;
  renderError?: string | null;
  createdAt: string;
  updatedAt: string;
};

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "ready":
      return <Badge className="bg-green-500/10 text-green-500 border-green-500/20">Ready</Badge>;
    case "rendering":
      return <Badge className="bg-yellow-500/10 text-yellow-500 border-yellow-500/20 animate-pulse">Rendering…</Badge>;
    case "failed":
      return <Badge className="bg-red-500/10 text-red-500 border-red-500/20">Failed</Badge>;
    default:
      return <Badge variant="outline" className="text-muted-foreground">Draft</Badge>;
  }
}

/** Polls a single project by id every `intervalMs` while its status is "rendering". */
function useProjectPolling(projectId: number, active: boolean, intervalMs = 3000) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
    }, intervalMs);
    return () => clearInterval(timer);
  }, [active, projectId, intervalMs, queryClient]);
}

function ProjectCard({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const deleteProject = useDeleteProject();
  const renderMutation = useStartProjectRender();
  const [showVideo, setShowVideo] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [upgradeReason, setUpgradeReason] = useState<"render_limit" | "premium_template">("render_limit");

  const isRendering = project.status === "rendering";
  const isReady = project.status === "ready";

  // Poll while rendering
  useProjectPolling(project.id, isRendering);

  const handleRender = () => {
    renderMutation.mutate(
      { id: project.id },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
        },
        onError: (err) => {
          // Check for upgrade_required 403 from backend
          const e = err as { response?: { data?: { reason?: string; error?: string } }; data?: { reason?: string; error?: string }; status?: number; message?: string };
          const reason = e.response?.data?.reason ?? e.data?.reason;
          const errorMsg = e.response?.data?.error ?? e.data?.error ?? e.message ?? "";
          if (reason === "upgrade_required" || e.status === 403) {
            if (errorMsg.toLowerCase().includes("template")) {
              setUpgradeReason("premium_template");
            } else {
              setUpgradeReason("render_limit");
            }
            setUpgradeOpen(true);
          }
        },
      },
    );
  };

  const handleDelete = () => {
    deleteProject.mutate(
      { id: project.id },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
        },
      },
    );
  };

  const videoSrc = project.videoUrl ?? `/api/projects/${project.id}/video`;

  return (
    <Card className="overflow-hidden transition-colors hover:border-primary/30 group">
      <CardContent className="p-0 flex items-stretch">
        {/* Thumbnail / status indicator */}
        <div className="w-40 bg-muted shrink-0 flex flex-col items-center justify-center border-r relative overflow-hidden">
          {project.thumbnailUrl ? (
            <img
              src={project.thumbnailUrl}
              alt={project.name}
              className="absolute inset-0 w-full h-full object-cover"
            />
          ) : (
            <Film className="h-8 w-8 text-muted-foreground/30" />
          )}
          {isRendering && (
            <div className="absolute inset-0 bg-background/60 backdrop-blur-sm flex flex-col items-center justify-center gap-2">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
              <span className="text-xs text-muted-foreground font-medium">Rendering…</span>
            </div>
          )}
          {isReady && (
            <div className="absolute inset-0 bg-background/40 backdrop-blur-[1px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer" onClick={() => setShowVideo(true)}>
              <Play className="h-8 w-8 text-white drop-shadow-lg" />
            </div>
          )}
        </div>

        {/* Details */}
        <div className="flex-1 p-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-3 mb-1">
              <h3 className="text-lg font-semibold truncate">{project.name}</h3>
              <StatusBadge status={project.status} />
            </div>
            <div className="flex items-center gap-4 text-sm text-muted-foreground flex-wrap">
              <Badge variant="outline" className="capitalize text-xs font-normal">
                {project.module}
              </Badge>
              {project.duration && (
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {project.duration}s
                </span>
              )}
              <span>Updated {new Date(project.updatedAt).toLocaleDateString()}</span>
            </div>
            {project.status === "failed" && project.renderError && (
              <div className="mt-2 flex items-start gap-1.5 text-xs text-destructive">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span className="truncate max-w-sm" title={project.renderError}>
                  {project.renderError}
                </span>
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 shrink-0">
            {/* Delete */}
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-destructive hover:text-destructive hover:bg-destructive/10"
                    onClick={handleDelete}
                    disabled={isRendering}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Delete project</TooltipContent>
              </Tooltip>
            </TooltipProvider>

            {/* Render button — shown only for draft status */}
            {project.status === "draft" && (
              <Button
                variant="outline"
                onClick={handleRender}
                disabled={renderMutation.isPending}
              >
                {renderMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Clapperboard className="mr-2 h-4 w-4" />
                )}
                Render
              </Button>
            )}

            {/* Re-render button — shown when ready or failed */}
            {(project.status === "ready" || project.status === "failed") && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleRender}
                disabled={renderMutation.isPending}
              >
                {renderMutation.isPending ? (
                  <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                ) : (
                  <Clapperboard className="mr-2 h-3 w-3" />
                )}
                Re-render
              </Button>
            )}

            {/* Watch button — only when ready */}
            {isReady && (
              <Button onClick={() => setShowVideo(true)}>
                <Play className="mr-2 h-4 w-4" />
                Watch
              </Button>
            )}
          </div>
        </div>
      </CardContent>

      {/* Video player dialog */}
      <Dialog open={showVideo} onOpenChange={setShowVideo}>
        <DialogContent className="max-w-4xl p-0 overflow-hidden bg-black">
          <video
            src={videoSrc}
            controls
            autoPlay
            className="w-full max-h-[70vh] rounded-lg"
          />
        </DialogContent>
      </Dialog>

      {/* Upgrade modal — shown when render is blocked due to plan limits */}
      <UpgradeModal
        open={upgradeOpen}
        onOpenChange={setUpgradeOpen}
        reason={upgradeReason}
      />
    </Card>
  );
}

export default function Projects() {
  const queryClient = useQueryClient();
  const { data: projects, isLoading, isError } = useListProjects();
  const createProject = useCreateProject();

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectModule, setNewProjectModule] = useState("studio");

  const hasRenderingProjects = projects?.some((p) => p.status === "rendering") ?? false;

  // Global poll when any project is rendering
  useProjectPolling(0, hasRenderingProjects);

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProjectName) return;
    createProject.mutate(
      { data: { name: newProjectName, module: newProjectModule } },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
          setIsCreateOpen(false);
          setNewProjectName("");
        },
      },
    );
  };

  if (isError) {
    return (
      <Layout>
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>Failed to load projects. Please try again later.</AlertDescription>
        </Alert>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Projects</h1>
          <p className="text-muted-foreground">Manage and render your video production projects.</p>
        </div>

        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" /> New Project
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create New Project</DialogTitle>
              <DialogDescription>Start a new video production project.</DialogDescription>
            </DialogHeader>
            <form onSubmit={handleCreate}>
              <div className="grid gap-4 py-4">
                <div className="grid gap-2">
                  <Label htmlFor="name">Project Name</Label>
                  <Input
                    id="name"
                    value={newProjectName}
                    onChange={(e) => setNewProjectName(e.target.value)}
                    placeholder="E.g., Q3 Marketing Promo"
                    autoFocus
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="module">Module</Label>
                  <select
                    id="module"
                    value={newProjectModule}
                    onChange={(e) => setNewProjectModule(e.target.value)}
                    className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <option value="studio">Studio</option>
                    <option value="ai">AI Gen</option>
                    <option value="bulk">Bulk Render</option>
                  </select>
                </div>
              </div>
              <DialogFooter>
                <Button type="submit" disabled={!newProjectName || createProject.isPending}>
                  {createProject.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Create Project
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid gap-4">
        {isLoading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-6 flex items-center gap-4">
                <Skeleton className="h-16 w-24 rounded-md" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-5 w-1/3" />
                  <Skeleton className="h-4 w-1/4" />
                </div>
                <Skeleton className="h-9 w-20" />
              </CardContent>
            </Card>
          ))
        ) : projects?.length ? (
          projects.map((project) => <ProjectCard key={project.id} project={project as Project} />)
        ) : (
          <div className="text-center py-16 border rounded-xl border-dashed">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-muted mb-4">
              <Film className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-medium mb-2">No projects yet</h3>
            <p className="text-muted-foreground max-w-sm mx-auto mb-6">
              Create your first video project and hit <strong>Render</strong> to produce a video.
            </p>
            <Button onClick={() => setIsCreateOpen(true)}>
              <Plus className="mr-2 h-4 w-4" /> Create First Project
            </Button>
          </div>
        )}
      </div>
    </Layout>
  );
}
