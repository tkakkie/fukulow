use std::process::{Command, Output};

pub(super) fn run_isolated_test(args: &[&str]) -> Output {
    Command::new(std::env::current_exe().unwrap())
        .args(args)
        .output()
        .unwrap()
}
