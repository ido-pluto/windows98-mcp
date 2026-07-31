use std::{fs, path::Path};

// Tauri requires a Windows ICO even for our intentionally no-installer build.
// Generate a tiny opaque 1x1 icon at build time so no binary asset needs to be
// maintained in the source tree.
fn main() {
    let icon = Path::new("icons/icon.ico");
    if !icon.exists() {
        fs::create_dir_all("icons").expect("create icon directory");
        let bytes: [u8; 70] = [
            0, 0, 1, 0, 1, 0, // ICO header
            1, 1, 0, 0, 1, 0, 32, 0, 48, 0, 0, 0, 22, 0, 0, 0, // entry
            40, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 1, 0, 32, 0,
            0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0, // BITMAPINFOHEADER
            0x4b, 0x84, 0xd9, 0xff, // BGRA pixel
            0, 0, 0, 0, // AND mask
        ];
        fs::write(icon, bytes).expect("write generated icon");
    }
    tauri_build::build()
}
