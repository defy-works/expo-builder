# SSH Key for Remote Mac Builds

Place your SSH private key in this directory as `id`.

```
.ssh-key/
  id          <-- your private key (e.g. copy of ~/.ssh/id_ed25519)
  README.md   <-- this file
```

This key is used by `bun eas build --remote` to rsync project files to the
remote Mac. On Windows, cwRsync's bundled SSH is used (Windows SSH agent is
incompatible with cwRsync). On macOS/Linux, the system `ssh` is used directly.

## Setup

1. Copy your private key:
   ```
   cp ~/.ssh/id_ed25519 .ssh-key/id
   ```

2. The key must match one in `~/.ssh/authorized_keys` on the remote Mac.

3. Lock down permissions (SSH rejects keys that are too open):

   **Windows:**
   ```
   icacls .ssh-key\id /inheritance:r /grant:r "%USERNAME%:R"
   ```

   **macOS / Linux:**
   ```
   chmod 600 .ssh-key/id
   ```

## Security

- This directory is gitignored — the key is never committed.
- Only the `id` file is used; other files in this directory are ignored.
