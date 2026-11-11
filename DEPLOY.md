# Deployment: Node.js Dependencies for Multiple Entry Points

This package uses `fs-ext` (native addon) for OS-level file locking across three deployment locations:

1. **Queue** (branch): `meme-radar-branch/src/modules/alert-queue.mjs`
2. **Watcher** (branch): `meme-radar-branch/scripts-production/fomo-trader-watch-integrated.mjs`
3. **Scanner** (branch): `meme-radar-branch/scan-accum/fomo-free/fomo-free-scan.mjs`

## Dependencies

- `fs-ext@2.1.1` - POSIX flock syscall binding (native)
- `nan@2.30.0` - Native Abstractions for Node.js (fs-ext dependency)

Total: 3 packages (including build artifacts)

## Deployment Layout

All entry points (queue, watcher, scanner) are packaged inside `meme-radar-branch/`:

```
/workspace/meme-radar-run/
  └── meme-radar-branch/
      ├── src/
      │   └── modules/
      │       └── alert-queue.mjs        # Queue entry
      ├── scripts-production/
      │   └── fomo-trader-watch-integrated.mjs  # Watcher entry
      ├── scan-accum/
      │   └── fomo-free/
      │       └── fomo-free-scan.mjs     # Scanner entry
      └── node_modules/                  # Shared dependencies
          ├── fs-ext/
          └── nan/
```

**Setup:**
```bash
cd /workspace/meme-radar-run
tar -xzf meme-radar-v17.tar.gz  # Extracts meme-radar-branch/ with all components
```

All three entry points share `meme-radar-branch/node_modules/` via Node.js's module resolution.

## Verification

After deployment, verify each entry point can load fs-ext:

```bash
# Queue
node -e "import fs from 'fs-ext'; console.log('Queue OK')" \
  /workspace/meme-radar-run/meme-radar-branch/src/modules/alert-queue.mjs

# Watcher
node -e "import fs from 'fs-ext'; console.log('Watcher OK')" \
  /workspace/meme-radar-run/meme-radar-branch/scripts-production/fomo-trader-watch-integrated.mjs

# Scanner
node -e "import fs from 'fs-ext'; console.log('Scanner OK')" \
  /workspace/meme-radar-run/meme-radar-branch/scan-accum/fomo-free/fomo-free-scan.mjs
```

## Offline Installation

The tarball includes pre-built native bindings for `fs-ext`. No compilation required if Node.js version and OS match build environment (Node v22+, Linux x64).

For different platforms, rebuild:
```bash
cd node_modules/fs-ext
npm rebuild
```

## Native Binding Location

`node_modules/fs-ext/build/Release/fs-ext.node` (compiled binary)
