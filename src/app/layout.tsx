import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Site Inspector · Technical SEO audit",
  description: "Analyze websites, understand issues, and review technical evidence.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><a href="#main-content" className="skip-link">Skip to content</a>{children}</body></html>;
}
