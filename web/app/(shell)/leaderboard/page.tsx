"use client";

import { EventBanner } from "@/components/EventBanner";
import { LeaderboardTable } from "@/components/LeaderboardTable";
import { PageHeader } from "@/components/PPanel";
import { useStatus } from "@/lib/useStatus";

export default function LeaderboardPage() {
  const status = useStatus();
  return (
    <div className="space-y-4">
      <PageHeader title="Leaderboard" sub="Live portfolio rankings across all registered teams." />
      <EventBanner status={status ?? { state: "PRE_LAUNCH" }} />
      <LeaderboardTable variant="full" />
    </div>
  );
}
