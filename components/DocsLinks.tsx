import Link from "next/link";
import { Github } from "lucide-react";

/** Public source. One definition so the nav and the auth screen cannot drift. */
export const REPO_URL = "https://github.com/Anuragp22/interview-assistant";

/** The architecture walkthrough: a real App Router route, public by design. */
export const WALKTHROUGH_URL = "/walkthrough";

/** Documentation + source links, shared by the practice nav and the auth screen. */
const DocsLinks = ({ className = "" }: { className?: string }) => (
  <div className={`flex items-center gap-3 ${className}`}>
    <Link
      href={WALKTHROUGH_URL}
      className="text-sm text-fg-muted hover:text-fg-strong transition-colors"
    >
      Documentation
    </Link>
    <a
      href={REPO_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Source on GitHub (opens in a new tab)"
      title="Source on GitHub"
      className="text-fg-muted hover:text-fg-strong transition-colors"
    >
      <Github className="size-[18px]" aria-hidden="true" />
    </a>
  </div>
);

export default DocsLinks;
