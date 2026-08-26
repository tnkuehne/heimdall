import { defineConfig } from "tsdown";

export default defineConfig({
	entry: {
		extension: "extension/extension.ts",
		prefs: "extension/prefs.ts",
	},
	clean: true,
	deps: {
		neverBundle: [/^(?:gi|resource):\/\//],
	},
	dts: false,
	failOnWarn: true,
	format: "esm",
	hash: false,
	minify: false,
	outDir: "build/extension",
	outputOptions: {
		minifyInternalExports: false,
	},
	platform: "neutral",
	sourcemap: false,
	target: "es2022",
	treeshake: true,
});
