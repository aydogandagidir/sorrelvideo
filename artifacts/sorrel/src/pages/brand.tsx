import React, { useState, useEffect } from "react";
import { Layout } from "@/components/layout";
import { useGetBrandKit, useUpdateBrandKit, getGetBrandKitQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertCircle, Save, Loader2, Image as ImageIcon, Upload } from "lucide-react";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";

export default function Brand() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: brandKit, isLoading, isError } = useGetBrandKit();
  const updateBrandKit = useUpdateBrandKit();

  const [formData, setFormData] = useState({
    companyName: "",
    primaryColor: "",
    secondaryColor: "",
    accentColor: "",
    fontFamily: "",
    logoUrl: ""
  });

  // Init form data when brand kit loads
  useEffect(() => {
    if (brandKit) {
      setFormData({
        companyName: brandKit.companyName || "",
        primaryColor: brandKit.primaryColor || "#000000",
        secondaryColor: brandKit.secondaryColor || "#ffffff",
        accentColor: brandKit.accentColor || "#000000",
        fontFamily: brandKit.fontFamily || "Inter",
        logoUrl: brandKit.logoUrl || ""
      });
    }
  }, [brandKit]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    updateBrandKit.mutate({
      data: formData
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetBrandKitQueryKey() });
        toast({
          title: "Brand kit updated",
          description: "Your changes have been saved successfully.",
        });
      },
      onError: () => {
        toast({
          title: "Error",
          description: "Failed to update brand kit. Please try again.",
          variant: "destructive"
        });
      }
    });
  };

  if (isError) {
    return (
      <Layout>
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>Failed to load brand kit. Please try again later.</AlertDescription>
        </Alert>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Brand Kit</h1>
          <p className="text-muted-foreground">Manage your visual identity across all videos.</p>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-8">
        <div>
          {isLoading ? (
            <Card>
              <CardHeader>
                <Skeleton className="h-6 w-1/3 mb-2" />
                <Skeleton className="h-4 w-1/2" />
              </CardHeader>
              <CardContent className="space-y-6">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="space-y-2">
                    <Skeleton className="h-4 w-20" />
                    <Skeleton className="h-10 w-full" />
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : (
            <form onSubmit={handleSave}>
              <Card>
                <CardHeader>
                  <CardTitle>Brand Assets</CardTitle>
                  <CardDescription>Configure your global brand styling.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  
                  <div className="space-y-2">
                    <Label htmlFor="companyName">Company Name</Label>
                    <Input 
                      id="companyName" 
                      name="companyName" 
                      value={formData.companyName} 
                      onChange={handleChange} 
                      placeholder="Acme Corp" 
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>Logo</Label>
                    <div className="flex items-center gap-4">
                      <div className="w-20 h-20 rounded-md border bg-muted flex items-center justify-center overflow-hidden">
                        {formData.logoUrl ? (
                          <img src={formData.logoUrl} alt="Logo preview" className="w-full h-full object-contain p-2" />
                        ) : (
                          <ImageIcon className="h-8 w-8 text-muted-foreground/50" />
                        )}
                      </div>
                      <div className="flex-1 space-y-2">
                        <Input 
                          id="logoUrl" 
                          name="logoUrl" 
                          value={formData.logoUrl} 
                          onChange={handleChange} 
                          placeholder="https://example.com/logo.png" 
                        />
                        <Button type="button" variant="outline" size="sm" className="w-full">
                          <Upload className="mr-2 h-4 w-4" /> Upload Custom Logo
                        </Button>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="fontFamily">Typography</Label>
                    <select 
                      id="fontFamily"
                      name="fontFamily"
                      value={formData.fontFamily}
                      onChange={handleChange}
                      className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <option value="Inter">Inter (Sans-serif)</option>
                      <option value="Space Mono">Space Mono (Monospace)</option>
                      <option value="Georgia">Georgia (Serif)</option>
                      <option value="system-ui">System Default</option>
                    </select>
                  </div>

                  <div className="grid grid-cols-3 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="primaryColor">Primary</Label>
                      <div className="flex gap-2">
                        <Input 
                          type="color" 
                          id="primaryColor" 
                          name="primaryColor" 
                          value={formData.primaryColor} 
                          onChange={handleChange} 
                          className="w-12 h-10 p-1 px-1 cursor-pointer" 
                        />
                        <Input 
                          value={formData.primaryColor} 
                          onChange={handleChange} 
                          name="primaryColor" 
                          className="flex-1 font-mono uppercase" 
                        />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="secondaryColor">Secondary</Label>
                      <div className="flex gap-2">
                        <Input 
                          type="color" 
                          id="secondaryColor" 
                          name="secondaryColor" 
                          value={formData.secondaryColor} 
                          onChange={handleChange} 
                          className="w-12 h-10 p-1 px-1 cursor-pointer" 
                        />
                        <Input 
                          value={formData.secondaryColor} 
                          onChange={handleChange} 
                          name="secondaryColor" 
                          className="flex-1 font-mono uppercase" 
                        />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="accentColor">Accent</Label>
                      <div className="flex gap-2">
                        <Input 
                          type="color" 
                          id="accentColor" 
                          name="accentColor" 
                          value={formData.accentColor} 
                          onChange={handleChange} 
                          className="w-12 h-10 p-1 px-1 cursor-pointer" 
                        />
                        <Input 
                          value={formData.accentColor} 
                          onChange={handleChange} 
                          name="accentColor" 
                          className="flex-1 font-mono uppercase" 
                        />
                      </div>
                    </div>
                  </div>

                  <Button type="submit" className="w-full" disabled={updateBrandKit.isPending}>
                    {updateBrandKit.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                    Save Brand Kit
                  </Button>
                </CardContent>
              </Card>
            </form>
          )}
        </div>

        {/* Live Preview */}
        <div className="lg:sticky lg:top-8 h-fit">
          <Card className="overflow-hidden border-2">
            <CardHeader className="bg-muted/50 border-b">
              <CardTitle className="text-sm font-medium flex items-center justify-between">
                <span>Live Preview</span>
                <span className="text-xs text-muted-foreground font-normal">Video Title Card</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div 
                className="aspect-video w-full flex flex-col items-center justify-center p-8 relative transition-colors duration-500"
                style={{ backgroundColor: formData.secondaryColor }}
              >
                <div className="absolute inset-0 opacity-10 bg-[radial-gradient(circle_at_center,black_1px,transparent_1px)] bg-[size:24px_24px]"></div>
                
                <div className="z-10 flex flex-col items-center text-center gap-6">
                  {formData.logoUrl ? (
                    <img src={formData.logoUrl} alt="Logo" className="h-16 object-contain" />
                  ) : (
                    <div 
                      className="w-16 h-16 rounded-full flex items-center justify-center text-2xl font-bold transition-colors duration-500"
                      style={{ backgroundColor: formData.primaryColor, color: formData.secondaryColor }}
                    >
                      {formData.companyName ? formData.companyName.charAt(0).toUpperCase() : "A"}
                    </div>
                  )}
                  
                  <div 
                    className="text-4xl font-bold transition-colors duration-500"
                    style={{ color: formData.primaryColor, fontFamily: formData.fontFamily }}
                  >
                    {formData.companyName || "Your Brand"}
                  </div>
                  
                  <div 
                    className="px-4 py-1 rounded-full text-sm font-medium transition-colors duration-500"
                    style={{ backgroundColor: formData.accentColor, color: formData.secondaryColor }}
                  >
                    New Feature Announcement
                  </div>
                </div>

                {/* Progress bar simulation */}
                <div className="absolute bottom-0 left-0 w-full h-2 bg-black/10">
                  <div 
                    className="h-full w-1/3 transition-colors duration-500"
                    style={{ backgroundColor: formData.primaryColor }}
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </Layout>
  );
}
