import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: 'Juancho-Fico Picks — Sleeper Draft Intelligence',
  description:
    'Live, league-aware fantasy football draft recommendations for Sleeper.',
  openGraph: {
    title: 'Juancho-Fico Picks',
    description: 'Know who to draft — and who can wait.',
    type: 'website',
    images: [
      {
        url: '/og.png',
        width: 1200,
        height: 630,
        alt: 'Juancho-Fico Picks — Know who to draft and who can wait.',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Juancho-Fico Picks',
    description: 'Know who to draft — and who can wait.',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
