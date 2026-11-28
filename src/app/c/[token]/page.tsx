import type { Metadata } from "next";
import { RoomConfigurator } from "@/components/room/RoomConfigurator";

export const metadata: Metadata = {
  title: "Udostępniona konfiguracja mebli 3D",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * A shared configuration link (/c/{token}). The page is the regular configurator: the token is read
 * in the browser (SharedLinkLoader), validated by the server and removed from the address bar. The page
 * itself contains nothing link-specific, so it is the same static shell for every token.
 */
export default function SharedConfigurationPage() {
  return <RoomConfigurator />;
}
