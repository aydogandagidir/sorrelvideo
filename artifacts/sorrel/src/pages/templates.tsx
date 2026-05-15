import React from "react";
import { Layout } from "@/components/layout";
import { useListTemplates } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, Clock, Tag } from "lucide-react";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";

export default function Templates() {
  const { data: templates, isLoading, isError } = useListTemplates();

  if (isError) {
    return (
      <Layout>
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>Failed to load templates. Please try again later.</AlertDescription>
        </Alert>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Templates</h1>
          <p className="text-muted-foreground">Browse and use predefined video layouts.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {isLoading ? (
          Array.from({ length: 6 }).map((_, i) => (
            <Card key={i} className="overflow-hidden flex flex-col">
              <Skeleton className="h-48 w-full rounded-none" />
              <CardHeader>
                <Skeleton className="h-5 w-2/3 mb-2" />
                <Skeleton className="h-4 w-full" />
              </CardHeader>
              <CardContent className="flex-1">
                <div className="flex gap-2">
                  <Skeleton className="h-5 w-16 rounded-full" />
                  <Skeleton className="h-5 w-16 rounded-full" />
                </div>
              </CardContent>
            </Card>
          ))
        ) : templates?.length ? (
          templates.map((template) => (
            <Card key={template.id} className="overflow-hidden flex flex-col transition-all hover:border-primary/50">
              <div className="aspect-video w-full relative bg-muted overflow-hidden">
                {template.thumbnailUrl ? (
                  <img src={template.thumbnailUrl} alt={template.name} className="object-cover w-full h-full" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-muted-foreground">
                    No preview
                  </div>
                )}
                {template.isPremium && (
                  <Badge className="absolute top-3 right-3 bg-primary text-primary-foreground">Premium</Badge>
                )}
              </div>
              <CardHeader>
                <CardTitle className="line-clamp-1">{template.name}</CardTitle>
                <CardDescription className="line-clamp-2 min-h-10">
                  {template.description || "No description provided."}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex-1">
                <div className="flex flex-wrap gap-2 mb-4">
                  <Badge variant="outline" className="capitalize">{template.module}</Badge>
                  <Badge variant="secondary" className="capitalize">{template.category}</Badge>
                </div>
                <div className="flex items-center text-sm text-muted-foreground gap-4">
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {template.duration}s
                  </span>
                  {template.tags && template.tags.length > 0 && (
                    <span className="flex items-center gap-1 line-clamp-1">
                      <Tag className="h-3 w-3" />
                      {template.tags.join(", ")}
                    </span>
                  )}
                </div>
              </CardContent>
              <CardFooter className="pt-0">
                <Button className="w-full">Use Template</Button>
              </CardFooter>
            </Card>
          ))
        ) : (
          <div className="col-span-full text-center py-12 text-muted-foreground border rounded-lg border-dashed">
            No templates found.
          </div>
        )}
      </div>
    </Layout>
  );
}
