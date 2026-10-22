
import esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/index.mjs"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  outfile: "dist/index.js",
  external: [],
});

console.log("Build completed: dist/index.js");
