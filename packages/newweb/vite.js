import { fileURLToPath } from "url"
import solidPlugin from "vite-plugin-solid"

export default {
  base: "/newweb/",
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  plugins: [solidPlugin()],
}
