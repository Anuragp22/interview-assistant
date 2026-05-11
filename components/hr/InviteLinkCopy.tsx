"use client";

import { useState } from "react";
import { Check, Copy, Loader2, Mail } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export default function InviteLinkCopy({ templateId }: { templateId: string }) {
  const [generating, setGenerating] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [email, setEmail] = useState("");

  async function generate() {
    setGenerating(true);
    setLink(null);
    try {
      const res = await fetch(`/api/templates/${templateId}/invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(email ? { candidateEmail: email } : {}),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "Failed to mint invite");
      }
      const url = `${window.location.origin}/take/${json.token}`;
      setLink(url);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setGenerating(false);
    }
  }

  async function copy() {
    if (!link) return;
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="card-border">
      <div className="flex flex-col gap-4 p-6">
        <div className="flex flex-col gap-1">
          <h3 className="text-base font-semibold text-fg-strong">
            Generate invite link
          </h3>
          <p className="text-sm text-fg-muted">
            Optional: lock to a specific email. Leave blank to generate an
            open link you can send to anyone (single-use, 14-day expiry).
          </p>
        </div>

        <div className="flex flex-col sm:flex-row gap-2">
          <Input
            type="email"
            placeholder="candidate@example.com (optional)"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={generating}
          />
          <Button onClick={generate} disabled={generating} className="gap-2">
            {generating ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Mail className="size-4" />
            )}
            Generate
          </Button>
        </div>

        {link && (
          <div className="flex items-center gap-2 rounded-md bg-surface-2 border border-border-default p-3">
            <code className="flex-1 text-xs text-fg-default truncate">
              {link}
            </code>
            <Button
              variant="ghost"
              size="sm"
              onClick={copy}
              className={cn("gap-1.5 transition-colors", copied && "text-success-100")}
            >
              {copied ? (
                <>
                  <Check className="size-3.5" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="size-3.5" />
                  Copy
                </>
              )}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
