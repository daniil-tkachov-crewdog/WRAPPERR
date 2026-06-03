import type { Metadata } from 'next';
import './globals.css';

// Root layout — Spectrum.
// Loads JetBrains Mono via Google Fonts so it's available app-wide as `font-family: 'JetBrains
// Mono'` (referenced by the `.font-mono` tailwind utility and inline styles for all metadata:
// model id, sidebar section labels, the ⌘N hint, composer helper line, "providers" label).
// Inter weights 400–700 are also pulled in here to cover the Spectrum copy (560/580/620 etc).
export const metadata: Metadata = {
  title: 'Wrapperr',
  description: 'One interface. Every AI.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap"
        />
      </head>
      <body className="antialiased" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
        {children}
      </body>
    </html>
  );
}
