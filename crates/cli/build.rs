use std::path::PathBuf;

fn main() {
    // Shared target directories may reuse this executable in another worktree.
    let manifest_dir = PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR").expect("Cargo sets CARGO_MANIFEST_DIR"),
    );
    println!("cargo:rerun-if-env-changed=CARGO_MANIFEST_DIR");
    codewhale_build_support::declare_rerun_conditions(&manifest_dir);
    // `chimera` is the binary users run and the one `model resolve` and every
    // other subcommand execute on. It carries the same startup and config-load
    // path as the TUI, so it needs the same main-thread stack; without this
    // it ran `fn main` on the Windows 1 MiB linker default.
    codewhale_build_support::configure_windows_main_stack("chimera");
    codewhale_build_support::emit_build_version(&manifest_dir, env!("CARGO_PKG_VERSION"));
}
