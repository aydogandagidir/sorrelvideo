import { Link } from "wouter";
import { Mail, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function CheckYourEmailPage() {
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
          <Mail className="h-12 w-12 mx-auto text-primary" />
          <CardTitle>Check your inbox</CardTitle>
          <CardDescription>
            We sent a verification link to the email on your account. Click it
            to confirm your address — you can keep using Sorrel in the meantime.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex justify-center">
          <Link href="/dashboard">
            <Button>Continue to dashboard</Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
