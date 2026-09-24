fn main() {
    if let Err(error) = rvx_cli::main() {
        eprintln!("ERROR: {error:#}");
        std::process::exit(1);
    }
}
