import js from "@eslint/js";
import globals from "globals";
import html from "eslint-plugin-html";

export default [
  {
    ignores: ["node_modules/**", "coverage/**", ".cache/**"],
  },
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs", "**/*.html"],
    plugins: {
      html,
    },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: [
      "**/*.test.js",
      "**/*.test.mjs",
      "scripts/**/*.mjs",
      "eslint.config.mjs",
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    // Workshop starter and progressive-chapter scaffold files intentionally pre-declare
    // helper functions and parameters for learners to wire up in subsequent steps.
    files: [
      "**/begin/**/*.js",
      "**/begin/**/*.html",
      "5-virtualisation/5-4-1-elements-pool-and-recycling-preparation/end/virtual-list.js",
      "5-virtualisation/5-4-2-elements-pool-and-recycling-rendering/end/virtual-list.js",
      "5-virtualisation/5-5-top-observer/end/virtual-list.js",
      "utils/db.js",
    ],
    rules: {
      "no-unused-vars": "off",
    },
  },
];
