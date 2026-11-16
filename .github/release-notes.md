Daily tasks, notes, habits and a hardware-protected vault, now on Mac, Windows, Linux and Android. Free and open source. Everything stays on your device.

## Which file do I need?

| Your device | Download | First launch |
|---|---|---|
| **Mac** (macOS 14+, Apple Silicon or Intel) | `.dmg` | Drag Notemaker to Applications. If macOS says it can't be opened: System Settings → Privacy & Security → **Open Anyway** (once). |
| **Windows** 10/11, x64 | `.msi` or `x64-setup.exe` | If you see "Windows protected your PC": **More info → Run anyway** (once). |
| **Windows** on ARM | `arm64-setup.exe` | Same as above. |
| **Ubuntu / Debian / Mint** | `.deb` (`amd64` or `arm64`) | `sudo apt install ./<file>.deb` |
| **Fedora / openSUSE** | `.rpm` (`x86_64` or `aarch64`) | `sudo dnf install ./<file>.rpm` |
| **Any other Linux** | `.AppImage` | `chmod +x <file>.AppImage`, then run it |
| **Android** 7+ | `android-universal.apk` | Open it on the phone and allow installs from that app when asked. |

The warnings on Mac and Windows appear because Notemaker isn't signed with a paid certificate. The full guide is in the [README](https://github.com/more-than-hacking/Notemaker#install).

## The vault on each device

- **Mac:** Secure Enclave, with Touch ID
- **Windows:** Windows Hello (face, fingerprint or PIN; the key is held in the TPM)
- **Linux:** a USB security key (YubiKey or any FIDO2 key), or a recovery key only
- **Android:** the phone's hardware keystore, with fingerprint or screen lock

To move to a new device, use **Move to a New Device…** in the old app, then open the `.notemaker` file on the new one.

## Check your download (optional)

Every file was built by GitHub Actions from this repository's public code. To confirm a file is genuine and unmodified, install the [GitHub CLI](https://cli.github.com) and run:

```bash
gh attestation verify <downloaded-file> --repo more-than-hacking/Notemaker
```

Or compare the file's SHA-256 with the list below (`shasum -a 256 <file>` on Mac/Linux, `Get-FileHash <file>` in PowerShell).
