import TemplateForm from "@/components/hr/TemplateForm";

export default function NewTemplatePage() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2 max-w-2xl mx-auto w-full">
        <h1 className="font-display text-3xl tracking-tight text-fg-strong">
          New template
        </h1>
        <p className="text-fg-muted text-sm">
          Generation typically takes 5–15 seconds.
        </p>
      </div>
      <TemplateForm />
    </div>
  );
}
