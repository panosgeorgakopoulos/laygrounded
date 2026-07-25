import type { MetadataRoute } from "next";

const BASE = process.env.NEXT_PUBLIC_SITE_URL || "https://laygrounded.com";

// Marketing pages and the public Knowledge Base are crawlable; the
// authenticated app, token-gated claim rooms, the OAuth surface and the API are
// not. (Rooms are additionally noindex per-page.)
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/api/",
        "/oauth/",
        "/rooms/",
        "/claims",
        "/analytics",
        "/compliance",
        "/simulator",
        "/settings",
        "/sign-in",
        "/sign-up",
      ],
    },
    sitemap: `${BASE}/sitemap.xml`,
  };
}
