'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Separator } from '@/components/ui/separator';
import { Input } from '@/components/ui/input';
import { Activity, FolderGit2, ListChecks, Settings as SettingsIcon, Search } from 'lucide-react';

/**
 * The dashboard shell. Wraps every page in the sidebar + header layout
 * from the shadcn dashboard reference, themed dark / zinc by default.
 *
 * Sidebar nav items: Dashboard, Repositories, Findings, Settings.
 * The Findings and Settings pages are real (not stubs) but minimal —
 * Findings shows a coming-soon placeholder, Settings the same.
 *
 * The header has a (decorative) search input and a user avatar
 * placeholder. Both are non-interactive in MVP.
 */
const NAV_ITEMS = [
  { href: '/', label: 'Dashboard', icon: Activity },
  { href: '/repositories', label: 'Repositories', icon: FolderGit2 },
  { href: '/findings', label: 'Findings', icon: ListChecks },
  { href: '/settings', label: 'Settings', icon: SettingsIcon },
] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href);

  return (
    <SidebarProvider defaultOpen>
      <Sidebar
        variant="inset"
        className="border-r border-zinc-800/80 bg-zinc-900/40"
      >
        <SidebarHeader className="px-4 py-4">
          <Link href="/" className="flex items-center gap-2">
            <div className="flex size-7 items-center justify-center rounded-md bg-emerald-500/15 font-mono text-sm font-bold text-emerald-400">
              D
            </div>
            <div>
              <div className="text-sm font-semibold tracking-tight text-zinc-100">
                DriftGuard
              </div>
              <div className="text-[10px] uppercase tracking-wider text-zinc-500">
                Dependency drift
              </div>
            </div>
          </Link>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Navigation</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {NAV_ITEMS.map((item) => (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      render={<Link href={item.href} />}
                      isActive={isActive(item.href)}
                    >
                      <item.icon />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter className="px-3 py-3">
          <Separator className="mb-3 bg-zinc-800" />
          <div className="flex items-center gap-3 px-2">
            <Avatar className="size-7 border border-zinc-800">
              <AvatarFallback className="bg-zinc-800 text-xs text-zinc-300">
                VA
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium text-zinc-200">
                Vara-Ali
              </div>
              <div className="truncate text-[10px] text-zinc-500">
                Dev workspace
              </div>
            </div>
          </div>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset className="bg-zinc-950">
        <header className="sticky top-0 z-30 flex h-12 items-center gap-3 border-b border-zinc-800/80 bg-zinc-950/80 px-4 backdrop-blur">
          <SidebarTrigger className="-ml-1 text-zinc-400 hover:text-zinc-100" />
          <Separator orientation="vertical" className="h-5 bg-zinc-800" />
          <div className="relative max-w-md flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-zinc-500" />
            <Input
              placeholder="Search runs, packages, PRs…"
              className="h-8 border-zinc-800 bg-zinc-900/50 pl-8 font-sans text-sm text-zinc-200 placeholder:text-zinc-500"
            />
          </div>
          <div className="flex-1" />
          <div className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
            DriftGuard · Phase 2
          </div>
        </header>
        {children}
      </SidebarInset>
    </SidebarProvider>
  );
}