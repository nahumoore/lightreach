"use client"

import { useTheme } from "@/components/theme-provider"
import { Button } from "@workspace/ui/components/button"
import { SidebarTrigger } from "@workspace/ui/components/sidebar"
import { Separator } from "@workspace/ui/components/separator"
import { IconSun, IconMoon } from "@tabler/icons-react"
import { usePathname } from "next/navigation"

const routeLabels: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/connections": "Connections",
  "/leads": "Leads",
  "/sequences": "Sequences",
  "/suppressions": "Suppressions",
  "/templates": "Templates",
  "/campaigns": "Campaigns",
  "/emails": "Emails",
  "/inbox": "Inbox",
  "/mcp": "MCP",
  "/settings": "Settings",
}

export function AppHeader() {
  const { resolvedTheme, setTheme } = useTheme()
  const pathname = usePathname()

  const label =
    Object.entries(routeLabels).find(([route]) =>
      route === "/" ? pathname === "/" : pathname.startsWith(route),
    )?.[1] ?? "Lightreach"

  return (
    <header className="bg-sidebar flex h-14 shrink-0 items-center gap-2 border-b px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 h-4" />
      <span className="text-sm font-medium">{label}</span>

      <div className="ml-auto">
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={() =>
            setTheme(resolvedTheme === "dark" ? "light" : "dark")
          }
          aria-label="Toggle theme"
        >
          {resolvedTheme === "dark" ? (
            <IconSun className="size-4" />
          ) : (
            <IconMoon className="size-4" />
          )}
        </Button>
      </div>
    </header>
  )
}
