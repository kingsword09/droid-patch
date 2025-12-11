# droid-patch

CLI tool to patch the droid binary with various modifications.

## Installation

```bash
npm install -g droid-patch
# or use directly with npx
npx droid-patch --help
```

## Usage

### Patch and create an alias

```bash
# Patch the default droid binary and create an alias
npx droid-patch --is-custom droid

# Specify a custom path to the droid binary
npx droid-patch --is-custom -p /path/to/droid my-droid

# Dry run - verify patches without actually applying them
npx droid-patch --is-custom --dry-run droid

# Verbose output
npx droid-patch --is-custom -v droid
```

### Available Options

| Option | Description |
|--------|-------------|
| `--is-custom` | Patch `isCustom:!0` to `isCustom:!1` (enables context compression for custom models) |
| `--dry-run` | Verify patches without actually modifying the binary |
| `-p, --path <path>` | Path to the droid binary (default: `~/.droid/bin/droid`) |
| `-o, --output <path>` | Output path for patched binary (default: `<path>.patched`) |
| `--no-backup` | Skip creating backup of original binary |
| `-v, --verbose` | Enable verbose output |

### Manage Aliases

```bash
# List all aliases
npx droid-patch list

# Remove an alias
npx droid-patch remove <alias-name>
```

## PATH Configuration

After creating an alias, you need to add the aliases directory to your PATH:

```bash
# Add to your shell config (~/.zshrc, ~/.bashrc, etc.)
export PATH="$HOME/.droid-patch/aliases:$PATH"
```

Or run the quick setup command shown after patching.

## How It Works

1. **Patching**: The tool searches for specific byte patterns in the droid binary and replaces them
2. **Alias Creation**:
   - Copies the patched binary to `~/.droid-patch/bins/`
   - Creates a symlink in `~/.droid-patch/aliases/`
   - On macOS, automatically re-signs the binary with `codesign`

## Available Patches

### `--is-custom`

Changes `isCustom:!0` (true) to `isCustom:!1` (false) for custom models.

**Purpose**: This may enable context compression (auto-summarization) for custom models, which is normally only available for official models.

**Note**: Side effects are unknown - test thoroughly before production use.

## License

MIT
