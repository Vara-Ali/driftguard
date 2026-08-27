import type { Metadata } from 'next';
import { IBM_Plex_Sans, IBM_Plex_Mono } from 'next/font/google';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AppShell } from '@/components/app-shell';
import './globals.css';

const plexSans = IBM_Plex_Sans({
  variable: '--font-plex-sans',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
});

const plexMono = IBM_Plex_Mono({
  variable: '--font-plex-mono',
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'DriftGuard',
  description: 'Detects silent breaking changes in tracked npm dependencies and opens draft PRs with code fixes.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${plexSans.variable} ${plexMono.variable} dark h-full antialiased`}
    >
      <body className="bg-zinc-950 text-zinc-100 font-sans min-h-full">
        <TooltipProvider delayDuration={150}>
          <AppShell>{children}</AppShell>
        </TooltipProvider>
      </body>
    </html>
  );
}