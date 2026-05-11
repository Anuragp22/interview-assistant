export default function DonePage() {
  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="card-border max-w-md w-full">
        <div className="flex flex-col gap-3 items-center text-center p-10">
          <h1 className="text-xl font-semibold text-fg-strong">
            Thanks — interview complete
          </h1>
          <p className="text-sm text-fg-muted">
            We&apos;ve sent your responses to the recruiter. They&apos;ll be in
            touch directly with the next step.
          </p>
          <p className="text-xs text-fg-subtle mt-2">
            You can close this tab.
          </p>
        </div>
      </div>
    </div>
  );
}
