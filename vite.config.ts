import vinext from "vinext";
import { defineConfig, loadEnv } from "vite";

function enabled(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "");
  const usePolling = enabled(
    environment.ATLAS_WATCH_POLLING ?? environment.CHOKIDAR_USEPOLLING,
  );
  return {
    server: usePolling
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [vinext()],
  };
});
