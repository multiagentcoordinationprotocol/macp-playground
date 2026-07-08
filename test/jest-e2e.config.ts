import type { Config } from 'jest';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.e2e-spec.ts$',
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
  testEnvironment: 'node',
  testTimeout: 30000,
  detectOpenHandles: true
};

export default config;
