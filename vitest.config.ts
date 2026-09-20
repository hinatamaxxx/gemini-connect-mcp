import { defineConfig } from 'vitest/config';
import fs from 'node:fs';
export default defineConfig({ plugins: [{ name: 'markdown-text', transform(_, id) { if (id.endsWith('.md')) return `export default ${JSON.stringify(fs.readFileSync(id, 'utf8'))}`; } }], test: { include: ['tests/**/*.test.ts'], testTimeout: 30000 } });
