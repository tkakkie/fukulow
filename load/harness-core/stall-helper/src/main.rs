// TCP proxies for the #668 target WebSocket connections.
mod connection;
mod read_gate;

use read_gate::ReadGate;
use std::io::{self, BufRead, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener};
use std::sync::Arc;
use std::thread;
use std::time::Instant;

fn main() -> io::Result<()> {
    let clock = Instant::now();
    let mut args = std::env::args().skip(1);
    let invalid = || {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "usage: fukulow-stall-helper PORT SOCKETS",
        )
    };
    let port: u16 = args
        .next()
        .ok_or_else(invalid)?
        .parse()
        .map_err(|_| invalid())?;
    let sockets: usize = args
        .next()
        .ok_or_else(invalid)?
        .parse()
        .map_err(|_| invalid())?;
    if port == 0 || sockets == 0 || args.next().is_some() {
        return Err(invalid());
    }
    let upstream = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let gate = Arc::new(ReadGate::default());
    for socket in 0..sockets {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        let port = listener.local_addr()?.port();
        let gate = Arc::clone(&gate);
        thread::Builder::new().spawn(move || {
            if let Err(error) = connection::serve(listener, upstream, socket, gate, clock) {
                eprintln!("target {socket}: {error}");
                let _ = writeln!(
                    io::stdout().lock(),
                    r#"{{"event":"socket_error","socket":{socket}}}"#
                );
            }
        })?;
        writeln!(
            io::stdout().lock(),
            r#"{{"event":"listening","socket":{socket},"port":{port}}}"#
        )?;
    }
    for line in io::stdin().lock().lines() {
        let line = line?;
        let now = || clock.elapsed().as_secs_f64() * 1000.0;
        let at = match line.as_str() {
            "pause" => {
                gate.pause()?;
                now()
            }
            "resume" => gate.resume(now)?,
            "ping" => now(),
            "quit" => return Ok(()),
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "unknown command",
                ));
            }
        };
        writeln!(
            io::stdout().lock(),
            r#"{{"event":"ack","command":"{line}","at":{at}}}"#
        )?;
    }
    Ok(())
}
