# Arch Linux

Each GitHub release includes an AppImage, `XariBulbul-<version>-linux-x86_64.AppImage`, which runs on Arch as is and updates itself:

```bash
chmod +x XariBulbul-*-linux-x86_64.AppImage
./XariBulbul-*-linux-x86_64.AppImage
```

The `PKGBUILD` here installs the same AppImage as a regular package (for example, to publish it on the AUR as `xari-bulbul-bin`): it goes to `/opt/Xari Bulbul`, adds `xari-bulbul` to your PATH and a desktop entry. Remove it with `sudo pacman -R xari-bulbul-bin`. A package install does not update itself; update it with `makepkg -si` from a newer PKGBUILD.

After each release, update `pkgver` and `_appimage`, and put the AppImage's checksum in `sha256sums` (`sha256sum XariBulbul-<version>-linux-x86_64.AppImage`).
