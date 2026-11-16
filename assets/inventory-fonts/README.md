# Embedded inventory fonts

These are server-side PDF rendering assets, not browser font requests. Generated PDFs embed subsets; readers do not need the app, these source files or external fonts. Source fonts total about 18.3 MiB, mostly the CJK face. Include their notices with any redistribution. They are not camera originals or family-record attachments.

- `DejaVuSans.ttf`: DejaVu Sans, copied without modification from the installed Fedora `dejavu-sans-fonts` distribution. Upstream: https://github.com/dejavu-fonts/dejavu-fonts . `DejaVu-LICENSE.txt` accompanies the file (Bitstream/Arev notices; DejaVu changes public domain).
- `NotoSansCJKsc-Regular.otf`: https://github.com/notofonts/noto-cjk/blob/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf . `NotoCJK-LICENSE.txt` is that revision's `Sans/LICENSE` (SIL OFL 1.1).
- `NotoEmoji.ttf`: https://github.com/google/fonts/blob/cc39c4c2c304bc368c9b7c311ea2bcc6013299fe/ofl/notoemoji/NotoEmoji%5Bwght%5D.ttf , copied without modification and given a filesystem-friendly filename. `NotoEmoji-LICENSE.txt` is the matching `OFL.txt` (SIL OFL 1.1). Emoji are monochrome in this printable inventory.

SHA-256 of source font bytes:

```text
f0d9a390aa7cf43999a2fd1502a47c381bc7809ab5fac6937f0f6dd6524096cd  DejaVuSans.ttf
2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b  NotoSansCJKsc-Regular.otf
de6c18832938afc99caf132b39d6a30a19bac7f2e812e28db2535b4608d27551  NotoEmoji.ttf
```

Glyph fallback uses complete grapheme clusters, including emoji sequences. A character absent from every embedded font causes generation to fail rather than quietly replacing family text with an empty box. These fonts do not establish universal language, bidirectional typography or final print approval; representative names and descriptions still need artifact inspection.
