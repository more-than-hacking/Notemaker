// No console window for the Windows release build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    notemaker_lib::run()
}
