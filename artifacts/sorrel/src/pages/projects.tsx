import React, { useState } from "react";
import { Layout } from "@/components/layout";
import { useListProjects, useCreateProject, useDeleteProject, getListProjectsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, Film, Play, Trash2, Clock, Plus, Loader2 } from "lucide-react";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "ready":
      return <Badge className="bg-green-500/10 text-green-500 border-green-500/20">Ready</Badge>;
    case "rendering":
      return <Badge className="bg-yellow-500/10 text-yellow-500 border-yellow-500/20">Rendering</Badge>;
    case "failed":
      return <Badge className="bg-red-500/10 text-red-500 border-red-500/20">Failed</Badge>;
    default:
      return <Badge variant="outline" className="text-muted-foreground">Draft</Badge>;
  }
}

export default function Projects() {
  const queryClient = useQueryClient();
  const { data: projects, isLoading, isError } = useListProjects();
  const createProject = useCreateProject();
  const deleteProject = useDeleteProject();

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectModule, setNewProjectModule] = useState("studio");

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProjectName) return;

    createProject.mutate({
      data: { name: newProjectName, module: newProjectModule }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
        setIsCreateOpen(false);
        setNewProjectName("");
      }
    });
  };

  const handleDelete = (id: number) => {
    deleteProject.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
      }
    });
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
          <p className="text-muted-foreground">Manage your video production projects.</p>
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
          Array.from({ length: 4 }).map((_, i) => (
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
          projects.map((project) => (
            <Card key={project.id} className="overflow-hidden transition-colors hover:border-primary/30 group">
              <CardContent className="p-0 flex items-stretch">
                <div className="w-40 bg-muted shrink-0 flex flex-col items-center justify-center border-r relative overflow-hidden">
                  {project.thumbnailUrl ? (
                    <img src={project.thumbnailUrl} alt={project.name} className="absolute inset-0 w-full h-full object-cover" />
                  ) : (
                    <Film className="h-8 w-8 text-muted-foreground/30" />
                  )}
                  {project.status === "rendering" && (
                    <div className="absolute inset-0 bg-background/60 backdrop-blur-sm flex items-center justify-center">
                      <Loader2 className="h-6 w-6 animate-spin text-primary" />
                    </div>
                  )}
                </div>
                
                <div className="flex-1 p-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-3 mb-1">
                      <h3 className="text-lg font-semibold">{project.name}</h3>
                      <StatusBadge status={project.status} />
                    </div>
                    <div className="flex items-center gap-4 text-sm text-muted-foreground">
                      <Badge variant="outline" className="capitalize text-xs font-normal">{project.module}</Badge>
                      {project.duration && (
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {project.duration}s
                        </span>
                      )}
                      <span>Updated {new Date(project.updatedAt).toLocaleDateString()}</span>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-2 opacity-100 md:opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button variant="ghost" size="icon" className="text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => handleDelete(project.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                    <Button variant="outline">
                      Open Editor
                    </Button>
                    {project.status === "ready" && (
                      <Button>
                        <Play className="mr-2 h-4 w-4" /> Watch
                      </Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))
        ) : (
          <div className="text-center py-16 border rounded-xl border-dashed">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-muted mb-4">
              <Film className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-medium mb-2">No projects yet</h3>
            <p className="text-muted-foreground max-w-sm mx-auto mb-6">
              Create your first video project to start using the Sorrel platform features.
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
