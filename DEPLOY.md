# Deployment: Node.js Dependencies for Multiple Entry Points

This package uses `fs-ext` (native addon) for OS-level file locking across three deployment locations:

1. **Queue** (branch): `meme-radar-branch/src/modules/alert-queue.mjs`
2. **Watcher** (sibling): `scripts-production/fomo-trader-watch-integrated.mjs`
3. **Scanner** (outside): `scan-accum/fomo-free/fomo-free-scan.mjs`

## Dependencies

- `fs-ext@2.1.1` - POSIX flock syscall binding (native)
- `nan@2.30.0` - Native Abstractions for Node.js (fs-ext dependency)

Total: 3 packages (including build artifacts)

## Deployment Layouts

### Option A: Shared Parent node_modules (Recommended)

```
/workspace/meme-radar-run/
  ├── node_modules/           # Shared dependencies
  │   ├── fs-ext/
  │   └── nan/
  ├── meme-radar-branch/      # Queue
  ├── fomo-trader-watch/      # Watcher (sibling)
  └── scan-accum/             # Scanner (outside)
```

**Setup:**
```bash
cd /workspace/meme-radar-run
cp -r meme-radar-branch/node_modules ./
```

Node.js module resolution walks up to parent directories, so all three entry points will find the shared `node_modules`.

### Option B: Per-Entry node_modules

```
/workspace/meme-radar-run/
  ├── meme-radar-branch/
  │   └── node_modules/       # Queue dependencies
  ├── fomo-trader-watch/
  │   └── node_modules/       # Watcher dependencies (copy from branch)
  └── scan-accum/
      └── node_modules/       # Scanner dependencies (copy from branch)
```

**Setup:**
```bash
cd /workspace/meme-radar-run
cp -r meme-radar-branch/node_modules fomo-trader-watch/
cp -r meme-radar-branch/node_modules scan-accum/
```

### Option C: Symlink (if filesystem supports)

```bash
cd /workspace/meme-radar-run/fomo-trader-watch
ln -s ../meme-radar-branch/node_modules node_modules

cd /workspace/meme-radar-run/scan-accum
ln -s ../meme-radar-branch/node_modules node_modules
```

## Verification

After deployment, verify each entry point can load fs-ext:

```bash
# Queue
node -e "import fs from 'fs-ext'; console.log('Queue OK')" \
  /workspace/meme-radar-run/meme-radar-branch/src/modules/alert-queue.mjs

# Watcher
node -e "import fs from 'fs-ext'; console.log('Watcher OK')" \
  /workspace/meme-radar-run/fomo-trader-watch/fomo-trader-watch.mjs

# Scanner
node -e "import fs from 'fs-ext'; console.log('Scanner OK')" \
  /workspace/meme-radar-run/scan-accum/fomo-free/fomo-free-scan.mjs
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
