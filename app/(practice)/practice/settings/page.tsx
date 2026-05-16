import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import LogoutButton from "@/components/LogoutButton";
import SettingsCv from "@/components/practice/SettingsCv";
import { getSavedCv } from "@/lib/actions/practice.action";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const cv = await getSavedCv();

  return (
    <div className="flex flex-col gap-6 max-w-2xl mx-auto w-full">
      <Link
        href="/practice"
        className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg-strong w-fit"
      >
        <ArrowLeft className="size-3.5" />
        Back to dashboard
      </Link>
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-fg-strong">
          Settings
        </h1>
        <p className="text-sm text-fg-muted">
          Manage your saved CV and account.
        </p>
      </header>

      <SettingsCv
        initialCv={
          cv
            ? {
                filename: cv.filename,
                uploadedAt: cv.uploadedAt,
                size: cv.extractedText.length,
              }
            : null
        }
      />

      <div className="card-border p-5 flex items-center justify-between">
        <span className="text-sm text-fg-default">Account</span>
        <LogoutButton />
      </div>
    </div>
  );
}
