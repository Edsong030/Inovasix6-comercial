/** Node-environment unit tests for pure logic (no React rendering/jsdom —
 * that would need @testing-library/react, a new dependency this phase
 * deliberately avoids). Mirrors apps/api's jest.config.js shape. */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts', 'tsx'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  // tsconfig.json has jsx:"preserve" (Next.js's own bundler handles JSX at
  // build time); ts-jest needs an actual transform, so tests use a small
  // override (tsconfig.jest.json) that only changes jsx to "react-jsx".
  transform: { '^.+\\.(t|j)sx?$': ['ts-jest', { tsconfig: 'tsconfig.jest.json' }] },
  moduleNameMapper: {
    '\\.module\\.css$': '<rootDir>/test/style-mock.js',
    '^@/(.*)$': '<rootDir>/$1',
  },
  testEnvironment: 'node',
};
