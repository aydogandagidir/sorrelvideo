import React from "react";
import { Layout } from "@/components/layout";
import { useListModules } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { AlertCircle, CheckCircle2, Blocks } from "lucide-react";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";

function ModuleStatusBadge({ status }: { status: string }) {
  switch (status) {
    case "active":
      return <Badge className="bg-primary text-primary-foreground">Active</Badge>;
    case "beta":
      return <Badge className="bg-blue-500/10 text-blue-500 border-blue-500/20">Beta</Badge>;
    case "coming_soon":
      return <Badge variant="outline" className="text-muted-foreground">Coming Soon</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export default function Modules() {
  const { data: modules, isLoading, isError } = useListModules();

  if (isError) {
    return (
      <Layout>
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>Failed to load modules. Please try again later.</AlertDescription>
        </Alert>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Platform Modules</h1>
          <p className="text-muted-foreground">Extend your Sorrel workspace with additional capabilities.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {isLoading ? (
          Array.from({ length: 6 }).map((_, i) => (
            <Card key={i} className="flex flex-col">
              <CardHeader>
                <div className="flex justify-between items-start mb-2">
                  <Skeleton className="h-10 w-10 rounded-md" />
                  <Skeleton className="h-5 w-16 rounded-full" />
                </div>
                <Skeleton className="h-6 w-1/2 mb-2" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-4/5" />
              </CardHeader>
              <CardContent className="flex-1">
                <div className="space-y-2 mt-4">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-3/4" />
                </div>
              </CardContent>
              <CardFooter className="pt-0 border-t mt-auto p-6">
                <div className="flex items-center justify-between w-full">
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-6 w-10 rounded-full" />
                </div>
              </CardFooter>
            </Card>
          ))
        ) : modules?.length ? (
          modules.map((module) => (
            <Card 
              key={module.id} 
              className={`flex flex-col transition-all ${module.status === 'coming_soon' ? 'opacity-70 bg-muted/30' : 'hover:border-primary/50'}`}
            >
              <CardHeader>
                <div className="flex justify-between items-start mb-4">
                  <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <Blocks className="h-6 w-6" />
                  </div>
                  <ModuleStatusBadge status={module.status} />
                </div>
                <CardTitle>{module.name}</CardTitle>
                <CardDescription className="min-h-[3rem] mt-2">
                  {module.description}
                </CardDescription>
              </CardHeader>
              
              <CardContent className="flex-1">
                {module.features && module.features.length > 0 && (
                  <div className="space-y-3">
                    <h4 className="text-sm font-medium text-foreground">Included features:</h4>
                    <ul className="space-y-2">
                      {module.features.map((feature, idx) => (
                        <li key={idx} className="flex items-start gap-2 text-sm text-muted-foreground">
                          <CheckCircle2 className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                          <span>{feature}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </CardContent>
              
              <CardFooter className="border-t p-6 mt-auto bg-muted/20">
                <div className="flex items-center justify-between w-full">
                  <span className="text-sm font-medium">
                    {module.status === 'coming_soon' ? 'Not Available' : 'Enable Module'}
                  </span>
                  <Switch 
                    disabled={module.status === 'coming_soon'} 
                    checked={module.status === 'active'}
                  />
                </div>
              </CardFooter>
            </Card>
          ))
        ) : (
          <div className="col-span-full text-center py-12 text-muted-foreground border rounded-lg border-dashed">
            No modules available.
          </div>
        )}
      </div>
    </Layout>
  );
}
