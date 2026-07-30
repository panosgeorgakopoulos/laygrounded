import type { Metadata } from "next";
import { WeatherCheckerClient } from "./weather-checker-client";

// Public, unauthenticated lead magnet. Deliberately outside the (authenticated)
// route group and outside the proxy's redirect list, so a logged-out visitor
// from a search result lands straight on the tool.
export const metadata: Metadata = {
  title: "Free weather dispute checker · LayGrounded",
  description:
    "Check whether weather really stopped cargo work at any port. Replays the hourly ERA5 archive against cargo-specific thresholds — the deterministic engine behind LayGrounded's demurrage claims.",
  openGraph: {
    title: "Free weather dispute checker",
    description:
      "Was it really too wet to work? Replay the hour-by-hour weather archive against your cargo's own sensitivity thresholds.",
    type: "website",
  },
  // Indexable on purpose: organic search for "was it raining at <port>" is
  // exactly the traffic this exists to capture.
  robots: { index: true, follow: true },
};

export default function WeatherCheckerPage() {
  return <WeatherCheckerClient />;
}
