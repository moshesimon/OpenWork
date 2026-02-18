import { defineConfig } from "@trigger.dev/sdk/v3";

const projectRef =
  process.env.TRIGGER_PROJECT_REF ?? process.env.TRIGGER_PROJECT_ID ?? "your-trigger-project-ref";

export default defineConfig({
  project: projectRef,
  runtime: "node",
  maxDuration: 300,
  dirs: ["./src/trigger"],
});
