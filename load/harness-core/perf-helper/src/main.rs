#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
mod collector;
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
mod counters;
#[cfg(any(all(target_os = "linux", target_arch = "x86_64"), test))]
mod protocol;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    return collector::run();

    #[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
    Err("the MSR collector requires x86-64 Linux".into())
}
