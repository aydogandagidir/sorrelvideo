import { Link, useSearch } from "wouter";
import { CheckCircle2, Video, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function EmailVerifiedPage() {
  const search = useSearch();
  const status = new URLSearchParams(search).get("status") ?? "invalid";
  const ok = status === "ok";

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-2 text-center">
          <Link
            href="/"
            className="inline-flex items-center justify-center gap-2 text-lg font-semibold"
          >
            <Video className="h-5 w-5" />
            Sorrel
          </Link>
          {ok ? (
            <CheckCircle2 className="h-12 w-12 mx-auto text-green-500" />
          ) : (
            <XCircle className="h-12 w-12 mx-auto text-destructive" />
          )}
          <CardTitle>{ok ? "Email verified" : "Link invalid"}</CardTitle>
          <CardDescription>
            {ok
              ? "Your email address is now verified."
              : "This verification link is invalid or has expired. Request a new one from the dashboard."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex justify-center">
          <Link href={ok ? "/dashboard" : "/login"}>
            <Button>{ok ? "Go to dashboard" : "Back to sign in"}</Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
