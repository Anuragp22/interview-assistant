import { Toaster } from "sonner";
import type { Metadata } from "next";
import { Mona_Sans } from "next/font/google";

import "./globals.css";

const monaSans = Mona_Sans({
  variable: "--font-mona-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "JobVoice",
  description: "An AI-powered platform for preparing for mock interviews",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${monaSans.className} antialiased`}>
        {children}

        <Toaster
          theme="dark"
          richColors
          closeButton
          toastOptions={{
            classNames: {
              toast:
                "!bg-surface-1 !border !border-border-default !text-fg-strong !shadow-lg",
              description: "!text-fg-muted",
              actionButton:
                "!bg-accent !text-accent-fg hover:!bg-accent-hover",
              cancelButton: "!bg-surface-2 !text-fg-default",
              closeButton:
                "!bg-surface-2 !border-border-default !text-fg-muted hover:!text-fg-strong",
            },
          }}
        />
      </body>
    </html>
  );
}
