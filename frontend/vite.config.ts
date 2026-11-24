import { defineConfig } from 'vitest/config';
import { sessionTemplate } from './session-template.ts';
export default defineConfig({ base: './', plugins: [sessionTemplate()], test: { include: ['tests/**/*.test.ts'] } });
