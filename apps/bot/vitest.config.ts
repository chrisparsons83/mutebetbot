import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'bot',
    include: ['src/**/*.test.ts'],
  },
});
