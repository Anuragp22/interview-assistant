import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/actions/auth.action";
import InterviewForm from "./_components/InterviewForm";

const Page = async () => {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  return (
    <>
      <h3>Interview generation</h3>
      <InterviewForm userId={user.id} />
    </>
  );
};

export default Page;
