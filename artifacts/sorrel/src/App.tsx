import { type ComponentType } from "react";
import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuth } from "@workspace/auth-web";

import Home from "./pages/home";
import Pricing from "./pages/pricing";
import Login from "./pages/login";
import Signup from "./pages/signup";
import ForgotPassword from "./pages/forgot-password";
import ResetPassword from "./pages/reset-password";
import EmailVerified from "./pages/email-verified";
import CheckYourEmail from "./pages/check-your-email";
import Dashboard from "./pages/dashboard";
import Studio from "./pages/studio";
import Templates from "./pages/templates";
import WebsiteToVideo from "./pages/website-to-video";
import Projects from "./pages/projects";
import Brand from "./pages/brand";
import Modules from "./pages/modules";
import Bulk from "./pages/bulk";
import Analytics from "./pages/analytics";
import Collab from "./pages/collab";
import Avatar from "./pages/avatar";
import Settings from "./pages/settings";
import Terms from "./pages/terms";
import Privacy from "./pages/privacy";
import NotFound from "./pages/not-found";
import { CookieConsent } from "@/components/cookie-consent";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function ProtectedRoute({
  component: Component,
}: {
  component: ComponentType;
}) {
  const { isAuthenticated, isLoading, login } = useAuth();
  const [location] = useLocation();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground text-sm">
          Loading...
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    // Preserve the attempted deep link so login bounces back here afterward.
    login(location);
    return null;
  }

  return <Component />;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/pricing" component={Pricing} />
      <Route path="/login" component={Login} />
      <Route path="/signup" component={Signup} />
      <Route path="/forgot-password" component={ForgotPassword} />
      <Route path="/reset-password" component={ResetPassword} />
      <Route path="/email-verified" component={EmailVerified} />
      <Route path="/check-your-email" component={CheckYourEmail} />
      <Route path="/terms" component={Terms} />
      <Route path="/privacy" component={Privacy} />
      <Route path="/dashboard">
        <ProtectedRoute component={Dashboard} />
      </Route>
      <Route path="/studio">
        <ProtectedRoute component={Studio} />
      </Route>
      <Route path="/templates">
        <ProtectedRoute component={Templates} />
      </Route>
      <Route path="/website-to-video">
        <ProtectedRoute component={WebsiteToVideo} />
      </Route>
      <Route path="/projects">
        <ProtectedRoute component={Projects} />
      </Route>
      <Route path="/brand">
        <ProtectedRoute component={Brand} />
      </Route>
      <Route path="/modules">
        <ProtectedRoute component={Modules} />
      </Route>
      <Route path="/bulk">
        <ProtectedRoute component={Bulk} />
      </Route>
      <Route path="/analytics">
        <ProtectedRoute component={Analytics} />
      </Route>
      <Route path="/collab">
        <ProtectedRoute component={Collab} />
      </Route>
      <Route path="/avatar">
        <ProtectedRoute component={Avatar} />
      </Route>
      <Route path="/settings">
        <ProtectedRoute component={Settings} />
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
          <CookieConsent />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
