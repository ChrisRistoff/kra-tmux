import typescript from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

export default [
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: {
      '@typescript-eslint': typescript,
    },

    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      project: './tsconfig.json',
      },
    },

    rules: {
       'no-unused-vars': 'off',
       '@typescript-eslint/no-unused-vars': ['error', {
           argsIgnorePattern: '^_',
           varsIgnorePattern: '^_',
           caughtErrorsIgnorePattern: '^_',
       }],
      'no-useless-escape': 'off',

      // Return types and function rules
      '@typescript-eslint/explicit-function-return-type': ['error', {
        allowExpressions: true,
        allowTypedFunctionExpressions: true,
        allowHigherOrderFunctions: true,
        allowDirectConstAssertionInArrowFunctions: true,
      }],

      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/promise-function-async': 'error',

      // Spacing and formatting
      'space-before-function-paren': ['error', {
        anonymous: 'always',
        named: 'never',
        asyncArrow: 'always',
      }],

      'space-before-blocks': 'error',
      'keyword-spacing': ['error', { before: true, after: true }],
      'space-infix-ops': 'error',

      'padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: '*', next: 'return' },
      ],

    // Type checking and safety
    '@typescript-eslint/no-explicit-any': 'warn',

    '@typescript-eslint/no-non-null-assertion': 'warn',
    '@typescript-eslint/no-unnecessary-type-assertion': 'error',
    '@typescript-eslint/no-unsafe-assignment': 'warn',
    '@typescript-eslint/no-unsafe-member-access': 'warn',
    '@typescript-eslint/no-unsafe-call': 'warn',
    '@typescript-eslint/await-thenable': 'error',
    '@typescript-eslint/no-floating-promises': 'error',

    // Code quality
    '@typescript-eslint/no-empty-function': ['error', { allow: ['private-constructors'] }],
    '@typescript-eslint/no-empty-interface': ['error', { allowSingleExtends: true }],
    '@typescript-eslint/no-inferrable-types': 'error',
    '@typescript-eslint/no-unnecessary-condition': 'warn',
    '@typescript-eslint/prefer-optional-chain': 'error',
    '@typescript-eslint/prefer-nullish-coalescing': 'error',
    '@typescript-eslint/unified-signatures': 'error',

    // Best practices
    '@typescript-eslint/consistent-type-assertions': [
      'error',
      { assertionStyle: 'as', objectLiteralTypeAssertions: 'never' },
    ],

    // '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
    '@typescript-eslint/method-signature-style': ['error', 'property'],
    '@/no-duplicate-imports': 'error',
    '@typescript-eslint/no-shadow': 'error',
    '@typescript-eslint/prefer-for-of': 'error',
    '@typescript-eslint/prefer-function-type': 'error',

    // Naming conventions
    '@typescript-eslint/naming-convention': [
      'error',
      {
        selector: 'variable',
        format: ['camelCase', 'UPPER_CASE'],
      },

      {
        selector: 'parameter',
        format: ['camelCase'],
        leadingUnderscore: 'allow',
      },

      {
        selector: 'memberLike',
        modifiers: ['private'],
        format: ['camelCase'],
        leadingUnderscore: 'allow',
      },

      {
        selector: 'typeLike',
        format: ['PascalCase'],
      },

      {
        selector: 'interface',
        format: ['PascalCase'],
        prefix: ['I'],
      },
    ],
    },
  },
];

