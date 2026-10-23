import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import nodeResolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";

const isWatching = !!process.env.ROLLUP_WATCH;
const sdPlugin = "com.var.contextdeck.sdPlugin";
const resolveNode = () => nodeResolve({ browser: false, exportConditions: ["node"], preferBuiltins: true });
const modulePkg = { name: "emit-module-package-file", generateBundle() { this.emitFile({ fileName: "package.json", source: `{ "type": "module" }`, type: "asset" }); } };

export default [
	{
		input: "src/plugin.ts",
		output: { file: `${sdPlugin}/bin/plugin.js`, sourcemap: isWatching },
		plugins: [
			{ name: "watch-externals", buildStart() { this.addWatchFile(`${sdPlugin}/manifest.json`); } },
			typescript({ include: ["src/**/*.ts"] }),
			resolveNode(), commonjs(), !isWatching && terser(), modulePkg,
		],
	},
	{
		input: "mcp/server.ts",
		output: { file: `${sdPlugin}/mcp/contextdeck-mcp.mjs`, banner: "#!/usr/bin/env node" },
		plugins: [typescript({ include: ["mcp/**/*.ts", "src/**/*.ts"] }), json(), resolveNode(), commonjs(), !isWatching && terser()],
	},
];
