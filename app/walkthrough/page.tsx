import type { Metadata } from "next";

import Walkthrough from "@/components/walkthrough/Walkthrough";

export const metadata: Metadata = {
  title: "Architecture walkthrough | JobVoice",
  description:
    "How the JobVoice panel-interview simulator actually works: the whole system map, the realtime voice loop, the scoring path, and the harnesses that keep both honest.",
};

/**
 * Public route, deliberately outside the (auth) and (practice) groups, so it is
 * readable before anyone has an account. It inherits the root layout, which is
 * where the dark class and the fonts live.
 */
const WalkthroughPage = () => <Walkthrough />;

export default WalkthroughPage;
