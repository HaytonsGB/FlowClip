# Third-party notices

FlowClip's own source code is [MIT licensed](LICENSE). The Windows installer additionally
redistributes the components below, which carry their own terms.

## FFmpeg — GPL v3

`ffmpeg.exe` and `ffprobe.exe` are bundled with the installer.

| | |
| --- | --- |
| Licence | GNU General Public License v3 or later |
| Build used | [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) (`win64-gpl`) |
| Upstream source | https://github.com/FFmpeg/FFmpeg |
| Licence text | https://www.gnu.org/licenses/gpl-3.0.html |

FlowClip invokes FFmpeg as a separate executable over a command-line interface and contains
no FFmpeg code, so the two remain separate works and FlowClip's own source stays MIT.

The GPL build is used deliberately: H.264 export depends on `libx264`, which is GPL and is
absent from LGPL builds. The complete corresponding source for the bundled binaries is
available from the FFmpeg repository above, and the exact scripts used to produce them from
the BtbN repository.

## Electron and npm dependencies

Electron is MIT licensed, as are React, and the remaining runtime dependencies. Each package
ships its own licence text inside `node_modules`; run `npm ls` to enumerate the tree for a
given build.

## Application artwork

The FlowClip logo and icon are the author's own work and are not covered by the MIT grant
above. Please do not reuse them to identify a different project.
