# Arch Linux

Each GitHub release includes a native Arch package, `XariBulbul-<version>-linux-x64.pacman`:

```bash
sudo pacman -U XariBulbul-0.1.0-linux-x64.pacman
```

It installs to `/opt/Xari Bulbul`, adds `xari-bulbul` to your PATH and a desktop entry. Remove it with `sudo pacman -R xari-bulbul`.

The `PKGBUILD` here installs the same release through `makepkg` (for example, to publish it on the AUR as `xari-bulbul-bin`). After each release, update `pkgver` and update `sha256sums` with the new file's checksum (`sha256sum XariBulbul-<version>-linux-x64.pacman`).
