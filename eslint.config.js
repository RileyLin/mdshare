import js from '@eslint/js';
import globals from 'globals';

// Each custom rule below records a mistake we don't want to review for again. The message says
// how to fix the root cause, because agents read lint output more reliably than docs.
const ourRules = {
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-new-func': 'error',
  'no-restricted-syntax': ['error',
    {
      selector: "CallExpression[callee.name='setTimeout'][arguments.1.value=0]",
      message: 'Zero-delay setTimeout hides an ordering bug instead of fixing it (copied quick fixes snowball). Fix the cause, or explain the real constraint in review.',
    },
    {
      selector: "CallExpression[callee.object.name='JSON'][callee.property.name='stringify'] > SpreadElement",
      message: 'Build explicit field lists for database writes; spreading request data lets clients set fields like is_public.',
    },
    {
      selector: "ObjectExpression > SpreadElement[argument.property.name='body']",
      message: 'Never spread req.body into a payload. List the fields you accept (visibility must stay server-controlled).',
    },
  ],
};

export default [
  { ignores: ['node_modules/**', 'mcp/**', 'public/**', 'e2e/proof/**', '.vercel/**', 'docs/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.node } },
    rules: ourRules,
  },
  {
    // Playwright page.evaluate callbacks run in the browser.
    files: ['e2e/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
];
