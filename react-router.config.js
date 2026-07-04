import { vercelPreset } from "@vercel/react-router/vite";

/** @type {import('@react-router/dev/config').Config} */
export default {
  // Server-side render (required for the Shopify embedded app + app proxy).
  ssr: true,
  presets: [vercelPreset()],
};
