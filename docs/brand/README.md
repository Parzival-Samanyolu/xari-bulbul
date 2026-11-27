# Xarı Bülbül logo

The logo is an edit of a real photograph of *Ophrys caucasica*, the Caucasian bee-orchid known in Azerbaijani as **xarı bülbül**. The flower was cut out of its background and placed on pure OLED black (`#000`).

- **Source photo:** [Офрис кавказская.JPG](https://commons.wikimedia.org/wiki/File:%D0%9E%D1%84%D1%80%D0%B8%D1%81_%D0%BA%D0%B0%D0%B2%D0%BA%D0%B0%D0%B7%D1%81%D0%BA%D0%B0%D1%8F.JPG) by Nuvens on Wikimedia Commons. It's in the **public domain**, so no attribution is required, but we credit it gladly.
- **The edit:**
  - GrabCut segmentation, seeded by hand (`cut.py`)
  - ragged sepal tip trimmed, edge feathered, and a slight contrast and saturation lift (`compose.py`)

| File | Use |
|---|---|
| `logo-oled-1024.png` | Square logo on #000 |
| `icon-1024.png` | App icon: black rounded square on Apple's 1024 grid (824px body). Copied to `apps/desktop/build/icon.png`, which electron-builder turns into .icns/.ico/.png |
| `apps/desktop/src/renderer/src/assets/mark.png` | Transparent cut-out used inside the app (works on light and dark themes) |

To regenerate: download the source photo as `pd.jpg`, then run `python3 cut.py && python3 compose.py`. This needs `opencv-python`, `numpy` and `pillow`.
