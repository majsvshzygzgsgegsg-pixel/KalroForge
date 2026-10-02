import { defineConfig } from 'tsdown'

// Source-only library: client plugins bundle `src/` directly, so neither build face emits anything.
export default defineConfig({ entry: '' })
