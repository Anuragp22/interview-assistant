import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/actions/auth.action";
import InterviewForm from "./_components/InterviewForm";

const Page = async () => {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  return (
    <div className="flex flex-col gap-2 max-w-2xl mx-auto w-full">
      <div className="flex flex-col gap-2 mb-2">
        <h1 className="font-display text-4xl md:text-5xl tracking-tight text-fg-strong leading-[1.05]">
          Generate an <em className="italic">interview</em>
        </h1>
        <p className="text-fg-muted text-base">
          Tailor a mock interview to a specific role and level. We&apos;ll
          generate role-aware questions and run them live with an AI
          interviewer.
        </p>
      </div>
      <InterviewForm userId={user.id} />
    </div>
  );
};

export default Page;
