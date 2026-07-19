import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const forwardedHost = requestHeaders.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || requestHeaders.get("host") || "localhost:3000";
  const forwardedProtocol = requestHeaders
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim();
  const protocol =
    forwardedProtocol === "http" || forwardedProtocol === "https"
      ? forwardedProtocol
      : host.startsWith("localhost") || host.startsWith("127.0.0.1")
        ? "http"
        : "https";
  const origin = new URL(`${protocol}://${host}`);
  const description =
    "Local-first code intelligence for change impact, security evidence, and database relationships.";
  const image = new URL("/og.png", origin).toString();

  return {
    metadataBase: origin,
    title: {
      default: "Local Code Atlas",
      template: "%s · Local Code Atlas",
    },
    description,
    applicationName: "Local Code Atlas",
    category: "developer tools",
    openGraph: {
      type: "website",
      title: "Local Code Atlas",
      description:
        "Map a local project's change impact, security evidence, and database relationships without uploading the repository.",
      images: [{ url: image, width: 1200, height: 630, alt: "Local Code Atlas" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Local Code Atlas",
      description:
        "Evidence-first local code intelligence for impact, security, and data relationships.",
      images: [image],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
