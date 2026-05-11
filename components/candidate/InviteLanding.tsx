"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
} from "firebase/auth";
import { ArrowRight, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { auth } from "@/firebase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { signIn } from "@/lib/actions/auth.action";

export default function InviteLanding({
  token,
  templateTitle,
  templateRole,
  templateLevel,
}: {
  token: string;
  templateTitle: string;
  templateRole: string;
  templateLevel: string;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function start() {
    if (!email || !password) {
      toast.error("Email and password required");
      return;
    }
    setBusy(true);
    try {
      let cred;
      try {
        cred = await signInWithEmailAndPassword(auth, email, password);
      } catch {
        cred = await createUserWithEmailAndPassword(auth, email, password);
      }
      const idToken = await cred.user.getIdToken();
      await signIn({ email, idToken });

      const res = await fetch(`/api/invites/${token}/redeem`, {
        method: "POST",
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "Could not redeem invite");
      }

      await cred.user.getIdToken(true);
      router.push(`/take/${token}/upload-cv`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="card-border max-w-md w-full">
        <div className="flex flex-col gap-5 p-8">
          <div className="flex flex-col gap-2">
            <span className="inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-md bg-accent-soft border border-accent-border text-fg-strong w-fit">
              You&apos;ve been invited
            </span>
            <h1 className="font-display text-2xl tracking-tight text-fg-strong">
              {templateTitle}
            </h1>
            <p className="text-sm text-fg-muted">
              {templateRole} · {templateLevel}. You&apos;re about to take an
              AI-conducted interview. Your answers will be transcribed and
              reviewed by the hiring team.
            </p>
          </div>

          <div className="flex flex-col gap-3">
            <Input
              placeholder="Your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
            />
            <Input
              type="email"
              placeholder="Your email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
            />
            <Input
              type="password"
              placeholder="Choose a password (or sign in if you have one)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
            />
          </div>

          <Button onClick={start} disabled={busy} className="gap-2" size="lg">
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ArrowRight className="size-4" />
            )}
            Continue
          </Button>

          <p className="text-xs text-fg-subtle text-center">
            By continuing you confirm you understand this is an
            AI-conducted interview and agree to your responses being
            recorded as transcripts. We don&apos;t store audio.
          </p>
        </div>
      </div>
    </div>
  );
}
