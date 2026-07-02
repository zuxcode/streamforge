// @ts-check
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import prettierConfig from "eslint-config-prettier";

export default defineConfig(
	{
		// Global ignores — build output, deps, generated files.
		// Nothing under these paths should ever be linted.
		ignores: [
			"**/node_modules/**",
			"**/dist/**",
			"**/build/**",
			"**/.turbo/**",
			"coverage/**",
			"**/*.d.ts",
		],
	},

	js.configs.recommended,
	// ...tseslint.configs.recommended,

	{
		languageOptions: {
			parserOptions: {
				// Enables type-aware linting rules. Requires a tsconfig.json
				// (or per-package tsconfig via project service) to be discoverable
				// at each linted file's location — standard for a bun workspace
				// monorepo where each app/package has its own tsconfig.json.
				projectService: true,
				tsconfigRootDir: import.meta.resolve,
			},
		},
		rules: {
			// Bun/monorepo-friendly defaults — adjust to taste.
			"@typescript-eslint/no-unused-vars": [
				"warn",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
			],
			"@typescript-eslint/no-explicit-any": "warn",
			"@typescript-eslint/consistent-type-imports": "error",
			"no-console": ["warn", { allow: ["warn", "error"] }],
		},
	},

	{
		// Test files: relax a couple of rules that are noisy in test code.
		files: ["**/*.test.ts", "**/*.spec.ts", "**/__tests__/**"],
		rules: {
			"@typescript-eslint/no-explicit-any": "off",
			"no-console": "off",
		},
	},

	// Always keep prettier's config last — it disables ESLint stylistic
	// rules that would otherwise conflict with Prettier's own formatting.
	prettierConfig,
);
