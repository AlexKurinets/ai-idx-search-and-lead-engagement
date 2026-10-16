import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'IDX Search & Lead Engagement', template: '%s · IDX Search' },
  description: 'Mobile IDX search, AI texting and geo-farming for a multi-office brokerage group, on synthetic data.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-page text-ink">{children}</body>
    </html>
  );
}
