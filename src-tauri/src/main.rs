// Plyra Chess desktop shell. The window shows the bundled app straight away; closing it ends the process
// (nothing keeps running in the background).
//
// Updates: at every start the app checks for a newer signed version in the background. If there is one it is
// downloaded, its signature checked against the public key in tauri.conf.json, installed, and the app restarts
// into it (a few seconds). Nothing to download or click by hand.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri_plugin_updater::UpdaterExt;

async fn update(app: tauri::AppHandle) -> tauri_plugin_updater::Result<()> {
    if let Some(update) = app.updater()?.check().await? {
        update.download_and_install(|_chunk, _total| {}, || {}).await?;
        app.restart();
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let _ = update(handle).await; // offline or no update: carry on with this version
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Plyra Chess could not start");
}
