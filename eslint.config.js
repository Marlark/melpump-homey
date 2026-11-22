'use strict';

/*
 * Lint rules that find mistakes, not style: undefined and unused names, Node features
 * Homey Pro's Node 22 doesn't have (from "engines" in package.json), and Homey app
 * practices (Homey's timers and this.log). Run with `npm run lint`.
 */

const js = require('@eslint/js');
const n = require('eslint-plugin-n');
const homeyApp = require('eslint-plugin-homey-app');
const globals = require('globals');

module.exports = [
  {
    // Generated or not ours. The widget, pairing and repair pages are HTML with inline scripts.
    ignores: ['.homeybuild/**', 'node_modules/**', 'app.json'],
  },
  js.configs.recommended,
  n.configs['flat/recommended-script'],
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      // `homey` is provided by Homey when the app runs; it isn't an npm dependency.
      'n/no-missing-require': ['error', { allowModules: ['homey'] }],
      // Unused function arguments document the signature (e.g. Flow run listeners).
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
    },
  },
  {
    // The app itself: Homey's practices.
    files: ['app.js', 'api.js', 'drivers/**/*.js', 'lib/**/*.js', 'widgets/*/api.js'],
    ...homeyApp.configs['flat/recommended'],
    rules: {
      ...homeyApp.configs['flat/recommended'].rules,
      // Not in the plugin's recommended set: console output doesn't reach the Homey app log.
      'homey-app/homey-log': 'warn',
    },
  },
  {
    // Tests and scripts run in Node only, as command line tools.
    files: ['test/**/*.js', 'scripts/**/*.js', 'eslint.config.js'],
    rules: {
      'n/no-unpublished-require': 'off',
      'n/no-process-exit': 'off',
    },
  },
];
