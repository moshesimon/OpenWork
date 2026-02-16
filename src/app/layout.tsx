import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Thin Slack - Channels + DMs",
  description: "Local-first thin Slack clone with channels and direct messages.",
};

export const viewport: Viewport = {
  themeColor: "#f7efe0",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
