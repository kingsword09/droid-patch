# droid-patch

CLI tool to patch the droid binary with various modifications.

## Installation

```bash
npm install -g droid-patch
# or use directly with npx
npx droid-patch --help
```

## Usage

### Patch and Create an Alias

```bash
# Patch with --is-custom and create an alias
npx droid-patch --is-custom droid-custom

# Patch with --skip-login to bypass login requirement
npx droid-patch --skip-login droid-nologin

# Combine multiple patches
npx droid-patch --is-custom --skip-login droid-patched

# Specify a custom path to the droid binary
npx droid-patch --skip-login -p /path/to/droid my-droid

# Dry run - verify patches without actually applying them
npx droid-patch --skip-login --dry-run droid

# Verbose output
npx droid-patch --skip-login -v droid
```

### Output to a Specific Directory

```bash
# Output patched binary to current directory
npx droid-patch --skip-login -o . my-droid

# Output to a specific directory
npx droid-patch --skip-login -o /path/to/dir my-droid
```

### Available Options

| Option | Description |
|--------|-------------|
| `--is-custom` | Patch `isCustom:!0` to `isCustom:!1` (enables context compression for custom models) |
| `--skip-login` | Bypass login by injecting a fake `FACTORY_API_KEY` into the binary |
| `--dry-run` | Verify patches without actually modifying the binary |
| `-p, --path <path>` | Path to the droid binary (default: `~/.droid/bin/droid`) |
| `-o, --output <dir>` | Output directory for patched binary (creates file without alias) |
| `--no-backup` | Skip creating backup of original binary |
| `-v, --verbose` | Enable verbose output |

### Manage Aliases and Files

```bash
# List all aliases
npx droid-patch list

# Remove an alias
npx droid-patch remove <alias-name>

# Remove a patched binary file by path
npx droid-patch remove ./my-droid
npx droid-patch remove /path/to/patched-binary
```

### Check Version

```bash
npx droid-patch version
```

## PATH Configuration

When creating an alias (without `-o`), the tool will try to install to a directory already in your PATH (like `~/.local/bin`). If not available, you need to add the aliases directory to your PATH:

```bash
# Add to your shell config (~/.zshrc, ~/.bashrc, etc.)
export PATH="$HOME/.droid-patch/aliases:$PATH"
```

## How It Works

1. **Patching**: The tool searches for specific byte patterns in the droid binary and replaces them with equal-length replacements
2. **Alias Creation** (without `-o`):
   - Copies the patched binary to `~/.droid-patch/bins/`
   - Creates a symlink in a PATH directory or `~/.droid-patch/aliases/`
   - On macOS, automatically re-signs the binary with `codesign`
3. **Direct Output** (with `-o`):
   - Saves the patched binary directly to the specified directory
   - On macOS, automatically re-signs the binary with `codesign`

## Available Patches

### `--is-custom`

Changes `isCustom:!0` (true) to `isCustom:!1` (false) for custom models.

**Purpose**: This may enable context compression (auto-summarization) for custom models, which is normally only available for official models.

**Note**: Side effects are unknown - test thoroughly before production use.

### `--skip-login`

Replaces all `process.env.FACTORY_API_KEY` references in the binary with a hardcoded fake key `"fk-droid-patch-skip-00000"`.

**Purpose**: Bypass the login/authentication requirement without needing to set the `FACTORY_API_KEY` environment variable.

**How it works**: 
- The original code checks `process.env.FACTORY_API_KEY` to authenticate
- After patching, the code directly uses the fake key string, bypassing the env check
- This is a binary-level patch, so it works across all terminal sessions without any environment setup

## Examples

```bash
# Quick start: create a login-free droid alias
npx droid-patch --skip-login droid

# Create a standalone patched binary in current directory
npx droid-patch --skip-login -o . my-droid
./my-droid --version

# Clean up
npx droid-patch remove my-droid      # remove alias
npx droid-patch remove ./my-droid    # remove file
```

## License

MIT
