import { HeadContent, Scripts, createRootRoute } from "@tanstack/react-router"
import { Toaster } from "@/components/ui/sonner"
import appCss from "../styles.css?url"

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "PSP Video Converter — WebCodecs & MediaBunny" },
      { name: "description", content: "Ultra-fast in-browser PSP Go/1000/2000/3000 video encoder with WebCodecs hardware acceleration." },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
    ],
  }),
  notFoundComponent: () => (
    <main className="container mx-auto flex flex-col items-center justify-center min-h-[60vh] gap-4 p-4 text-center">
      <h1 className="text-2xl font-bold font-heading">Page Not Found</h1>
      <p className="text-sm text-muted-foreground">The requested page could not be found.</p>
    </main>
  ),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen bg-background text-foreground antialiased selection:bg-primary selection:text-primary-foreground font-sans">
        {children}
        <Toaster />
        <Scripts />
      </body>
    </html>
  )
}
