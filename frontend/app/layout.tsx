import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Spericorn Homes | Villa 3D POC",
  description: "CAD/BIM to GLB technical proof of concept",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
