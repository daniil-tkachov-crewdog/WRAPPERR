import type { Metadata } from 'next';
import './globals.css';

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
      <body className="bg-bg text-white antialiased">{children}</body>
    </html>
  );
}
