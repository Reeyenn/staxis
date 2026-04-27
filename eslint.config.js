const nextConfig = require('eslint-config-next');

module.exports = [
  {
    files: ['**/*.js', '**/*.jsx', '**/*.ts', '**/*.tsx'],
    ...nextConfig,
  },
];
