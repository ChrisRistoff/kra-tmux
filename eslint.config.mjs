import globals from "globals";
import pluginJs from "@eslint/js";
import tseslint from "typescript-eslint";


/** @type {import('eslint').Linter.Config[]} */
export default [
  {files: ["*.ts"]},
  {languageOptions: { globals: globals.node}},
  {rules: {
    'space-before-blocks': ['error', 'always'],
    'keyword-spacing': ['error', {
      before: true, after: true
    }],
    'semi': ['error', 'always'],
    "@typescript-eslint/no-unused-vars": [
      "error",
      {
        "argsIgnorePattern": "^_",
        "varsIgnorePattern": "^_",
        "caughtErrorsIgnorePattern": "^_"
      }
    ]
  }},

  {ignores: ['dest/']},
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
];
