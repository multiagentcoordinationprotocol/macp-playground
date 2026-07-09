import type { Config } from 'jest';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          types: ['node', 'jest']
        }
      }
    ]
  },
  collectCoverageFrom: ['**/*.ts', '!**/index.ts', '!main.ts'],
  coverageDirectory: '../coverage',
  // Floor a few points below measured coverage (2026-07: 85.9/69.7/88.1/86.9)
  // so regressions fail CI without blocking unrelated changes.
  coverageThreshold: {
    global: {
      statements: 83,
      branches: 67,
      functions: 85,
      lines: 84
    }
  },
  testEnvironment: 'node',
  detectOpenHandles: true
};

export default config;
